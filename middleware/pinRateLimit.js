// In-memory rate limiter + PIN re-auth middleware.
// Enforces 5 attempts / 15 min per (worker.id + route-group), then a 15 min
// lockout. Uses the same bcrypt comparison as /w/login so a correct PIN
// requires the live hash in crew_members.

const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const attempts = new Map(); // key -> { count, firstAt, lockedUntil }

function keyFor(workerId, group) { return `${workerId}:${group}`; }

function registerAttempt(key, success) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAt > WINDOW_MS) {
    rec = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  if (success) {
    attempts.delete(key);
    return { locked: false };
  }
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + WINDOW_MS;
  }
  attempts.set(key, rec);
  return { locked: rec.count >= MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - rec.count) };
}

function isLocked(key) {
  const rec = attempts.get(key);
  if (!rec) return { locked: false };
  const now = Date.now();
  if (rec.lockedUntil && rec.lockedUntil > now) {
    return { locked: true, secondsLeft: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  // Purge expired
  if (rec.firstAt && now - rec.firstAt > WINDOW_MS) {
    attempts.delete(key);
  }
  return { locked: false };
}

/**
 * Require fresh PIN re-entry for sensitive writes. Body field: pin_confirm.
 * Usage: router.post('/xxx', requirePinConfirm('bank'), handler)
 */
function requirePinConfirm(group) {
  return function (req, res, next) {
    const worker = req.session.worker;
    if (!worker || !worker.id) {
      req.flash('error', 'Session expired. Please sign in again.');
      return res.redirect('/w/login');
    }
    const key = keyFor(worker.id, group);
    const lock = isLocked(key);
    if (lock.locked) {
      req.flash('error', `Too many incorrect PIN attempts. Try again in ${Math.ceil(lock.secondsLeft / 60)} minutes.`);
      return res.redirect(req.headers.referer || '/w/hr');
    }

    const submitted = (req.body.pin_confirm || '').trim();
    if (!submitted) {
      req.flash('error', 'Enter your PIN to confirm this change.');
      return res.redirect(req.headers.referer || '/w/hr');
    }

    const db = getDb();
    const row = db.prepare('SELECT pin_hash FROM crew_members WHERE id = ?').get(worker.id);
    if (!row || !row.pin_hash || !bcrypt.compareSync(submitted, row.pin_hash)) {
      const outcome = registerAttempt(key, false);
      if (outcome.locked) {
        req.flash('error', 'Account locked for 15 minutes after 5 incorrect PIN attempts.');
      } else {
        req.flash('error', `Incorrect PIN. ${outcome.remaining} attempt${outcome.remaining === 1 ? '' : 's'} left.`);
      }
      return res.redirect(req.headers.referer || '/w/hr');
    }

    registerAttempt(key, true);
    // Strip pin from body before handler runs
    delete req.body.pin_confirm;
    next();
  };
}

module.exports = { requirePinConfirm };
