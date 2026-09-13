// Applicant-facing induction reminder SMS — ~2 hours before the booked
// induction time.
//
// The third induction reminder channel, and the most imminent:
//   * services/inductionReminders.js      — 7/3/1/0-day push to STAFF
//   * services/inductionEmailReminders.js — 36h/12h email to the APPLICANT
//   * this file                           — 2h SMS to the APPLICANT
//
// Same audience and phone number as the booking confirmation SMS in
// routes/recruitment.js (seek_applicants.phone, via services/sms.js), so a
// candidate who got the booking text gets the reminder on the same thread.
//
// Cron cadence: every 15 minutes. The window opens at T-2h and the first
// tick after that fires, so in practice the text lands between 2h00 and
// 1h45 before — close enough for "leaving now" to be the right action, and
// it can never fire late enough to be useless because the `now >= at` guard
// drops anything already started.
//
// Dedup: induction_sms_reminder_log (mig 360), keyed on applicant + window +
// date + time, exactly like the email log. Keying on the TIME as well means
// re-scheduling someone re-arms their reminder instead of silently eating it.
//
// A booked TIME is required — unlike the email reminders, which anchor 09:00
// when the time is blank. Telling someone their induction is "in about 2
// hours" when we never told them a time (the confirmation omits it too) is
// worse than staying quiet, and a guessed anchor would text them at 07:00.
//
// The channel no-ops until CLICKSEND_* env vars exist (services/sms.js), so
// the cron can call this unconditionally on any deploy.

'use strict';

// No raw db import — the handle is injected by the caller (server.js's cron
// tick, the allowlisted bootstrap). Mirrors inductionEmailReminders.js and
// keeps this file off the Phase 2 raw-getDb backlog.
const sms = require('./sms');
const { sydneyOffsetForDate } = require('../lib/sydney');

const WINDOW_HOURS = 2;
// Same skip list as the other two induction services: INDUCTED/HIRED means it
// already happened, NO_SHOW/DECLINED means it won't.
const SKIP_STAGES = new Set(['INDUCTED', 'HIRED', 'NO_SHOW', 'DECLINED']);
const DEPOT = '9 Epic Place, Villawood';
const CONTACT = '0410 170 194';

// 'YYYY-MM-DD' + 'HH:MM' (Sydney wall clock) → epoch ms, or null. Unlike the
// email twin there is no 09:00 fallback: no time means no reminder.
function inductionEpoch(dateStr, timeStr) {
  const iso = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hhmm = String(parseInt(m[1], 10)).padStart(2, '0') + ':' + m[2];
  const t = new Date(iso + 'T' + hhmm + ':00' + sydneyOffsetForDate(iso)).getTime();
  return Number.isFinite(t) ? t : null;
}

// "2:00 pm" from 'HH:MM'.
function clockText(timeStr) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + min + ' ' + ampm;
}

// Keep the body GSM-7-safe — no em dashes or curly quotes, or every segment
// shrinks from 153 to 67 chars and the cost per message triples.
function reminderBody(timeStr) {
  return 'T&S Traffic Control: Reminder, your induction is today at ' + clockText(timeStr) + '.\n\n' +
    'Address: ' + DEPOT + '.\n\n' +
    'Please bring hard copies of your licenses, and your superannuation details if applicable. ' +
    'Casual attire is fine.\n\n' +
    'If you can no longer make it, please call ' + CONTACT + '.';
}

/**
 * Send the 2-hour induction reminder SMS to every applicant due one.
 * `db` is injected by the caller. Returns { sent, scanned }.
 */
async function sendInductionSmsReminders(db) {
  if (!db) throw new Error('sendInductionSmsReminders requires a db handle (injected by the caller)');
  // Cheap exit before touching the DB when the channel isn't set up.
  if (!sms.isConfigured()) return { sent: 0, scanned: 0, skipped: 'not_configured' };

  // Bail safely on a DB that predates the tables.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('seek_applicants','induction_sms_reminder_log')"
  ).all().map(r => r.name);
  if (tables.length < 2) return { sent: 0, scanned: 0 };

  const now = Date.now();
  // A 2h window only ever spans today or (just past midnight) tomorrow; the
  // epoch check below does the exact maths.
  const rows = db.prepare(`
    SELECT id, applicant_name, phone, induction_date, induction_time, stage
    FROM seek_applicants
    WHERE induction_date IS NOT NULL AND induction_date != ''
      AND induction_time IS NOT NULL AND induction_time != ''
      AND DATE(induction_date) BETWEEN DATE('now', 'localtime') AND DATE('now', 'localtime', '+1 day')
      AND phone IS NOT NULL AND phone != ''
  `).all();

  const hasLog = db.prepare(
    'SELECT 1 FROM induction_sms_reminder_log WHERE applicant_id = ? AND hours_out = ? AND induction_date = ? AND induction_time = ?'
  );
  const insertLog = db.prepare(
    'INSERT OR IGNORE INTO induction_sms_reminder_log (applicant_id, hours_out, induction_date, induction_time) VALUES (?, ?, ?, ?)'
  );

  let sent = 0;
  for (const a of rows) {
    if (SKIP_STAGES.has(String(a.stage || '').toUpperCase())) continue;
    if (!sms.normalizeAuMobile(a.phone)) continue; // landline / malformed
    const at = inductionEpoch(a.induction_date, a.induction_time);
    if (!at || now >= at) continue; // unparseable or already started
    if (now < at - WINDOW_HOURS * 3600000) continue; // too early

    const timeKey = String(a.induction_time || '');
    if (hasLog.get(a.id, WINDOW_HOURS, a.induction_date, timeKey)) continue;

    let ok = null;
    try {
      ok = await sms.sendSms(a.phone, reminderBody(a.induction_time));
    } catch (e) {
      console.error('[induction-sms-reminder] send error for applicant', a.id, ':', e.message);
    }
    if (ok) {
      try { insertLog.run(a.id, WINDOW_HOURS, a.induction_date, timeKey); } catch (e) { /* dup — fine */ }
      sent++;
    }
    // Not sent (transient ClickSend failure): no log row, so the next 15-min
    // tick retries until the induction time passes.
  }

  if (sent > 0) console.log(`[induction-sms-reminder] texted ${sent} applicant(s)`);
  return { sent, scanned: rows.length };
}

module.exports = { sendInductionSmsReminders, inductionEpoch, reminderBody };
