const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { getComplianceStatus } = require('../../middleware/compliance');
const {
  buildGreetingSubtext, buildSmartCards, buildStreaks, buildTodayTimeline,
  loadPreferences, getWeather, geocodeAddress, localIso,
} = require('../../services/homeContext');

// GET /w/home — Worker home screen (dynamic, contextual)
router.get('/home', async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const todayDate = new Date();
  const today = localIso(todayDate);

  // ---- Kick off parallel work where it helps ----
  // Synchronous DB queries first (SQLite is sync) — all very fast
  const todaysShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC
  `).all(worker.id, today);

  const inTwoWeeks = new Date(todayDate); inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  const upcomingShifts = db.prepare(`
    SELECT ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type, ca.status,
           j.id as job_id, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date > ?
      AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC LIMIT 5
  `).all(worker.id, today, localIso(inTwoWeeks));

  // Week strip
  const weekStart = new Date(todayDate);
  const dow = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - dow);
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    weekDays.push({
      iso: localIso(d), dayLetter: ['M','T','W','T','F','S','S'][i], dayNum: d.getDate(),
      isToday: localIso(d) === today, isPast: localIso(d) < today,
    });
  }
  const weekAlloc = db.prepare(`
    SELECT allocation_date, shift_type, status FROM crew_allocations
    WHERE crew_member_id = ? AND allocation_date BETWEEN ? AND ? AND status != 'cancelled'
  `).all(worker.id, weekDays[0].iso, weekDays[6].iso);
  const weekLeave = db.prepare(`
    SELECT start_date, end_date, status FROM employee_leave
    WHERE crew_member_id = ? AND status != 'cancelled' AND NOT (end_date < ? OR start_date > ?)
  `).all(worker.id, weekDays[0].iso, weekDays[6].iso);
  weekDays.forEach(d => {
    const a = weekAlloc.find(x => x.allocation_date === d.iso);
    if (a) { d.kind = 'shift'; d.shiftType = a.shift_type; }
    const l = weekLeave.find(x => x.start_date <= d.iso && x.end_date >= d.iso);
    if (l && !a) { d.kind = 'leave'; d.leaveStatus = l.status; }
  });

  // Stats
  const last7 = new Date(todayDate); last7.setDate(last7.getDate() - 6);
  const hoursRow = db.prepare(`SELECT COALESCE(SUM(total_hours), 0) as hrs FROM timesheets
    WHERE crew_member_id = ? AND work_date BETWEEN ? AND ?`).get(worker.id, weekDays[0].iso, weekDays[6].iso);
  const daysWorkedRow = db.prepare(`SELECT COUNT(DISTINCT DATE(event_time)) as c FROM clock_events
    WHERE crew_member_id = ? AND event_type = 'clock_in' AND DATE(event_time) BETWEEN ? AND ?`).get(worker.id, localIso(last7), today);
  const pendingLeaveCount = db.prepare(`SELECT COUNT(*) as c FROM employee_leave
    WHERE crew_member_id = ? AND status = 'pending'`).get(worker.id).c;
  const stats = {
    hoursThisWeek: Number((hoursRow.hrs || 0).toFixed(1)),
    daysWorked: daysWorkedRow.c || 0,
    upcomingShifts: upcomingShifts.length,
    pendingLeave: pendingLeaveCount,
  };

  // Current shift status
  const lastClock = db.prepare(`SELECT event_type, event_time FROM clock_events
    WHERE crew_member_id = ? ORDER BY event_time DESC LIMIT 1`).get(worker.id);
  const onShift = lastClock && lastClock.event_type === 'clock_in';

  // Recent activity
  const recentClocks = db.prepare(`
    SELECT 'clock' as kind, event_type as subtype, event_time as at
    FROM clock_events WHERE crew_member_id = ? ORDER BY event_time DESC LIMIT 5
  `).all(worker.id);

  // Member + employee
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);
  let employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  if (!employee && member) employee = db.prepare('SELECT * FROM employees WHERE employee_code = ?').get(member.employee_id);

  const compliance = member ? getComplianceStatus(member, today) : null;

  // Greeting + subtext
  const hour = todayDate.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = worker.full_name.split(' ')[0];
  const subtext = buildGreetingSubtext(db, worker, member, employee, todaysShifts);

  // Smart cards + streaks (both persist rows)
  const cards = buildSmartCards(db, worker, member, employee);
  const streaks = buildStreaks(db, worker);

  // Preferences
  const prefs = loadPreferences(db, worker);

  // Today timeline
  const timeline = buildTodayTimeline(todaysShifts);

  // Weather for next shift site — or depot fallback when the worker has nothing scheduled.
  let weather = null;
  let weatherSource = null; // 'shift' | 'depot'
  try {
    const shiftForWeather = todaysShifts[0] || upcomingShifts[0];
    let q = null;
    if (shiftForWeather) {
      q = [shiftForWeather.suburb, shiftForWeather.site_address].filter(Boolean).join(', ');
      weatherSource = 'shift';
    } else {
      q = (process.env.DEPOT_SUBURB || 'Villawood NSW').trim();
      weatherSource = 'depot';
    }
    if (q) {
      const geo = await geocodeAddress(q);
      if (geo) weather = await getWeather(geo.lat, geo.lng);
      if (weather) {
        weather.source = weatherSource;
        weather.city = geo && geo.city ? geo.city : '';
        if (shiftForWeather) weather.forShift = shiftForWeather;
      }
    }
  } catch (e) { /* best effort */ }

  res.render('worker/home', {
    title: 'Home', currentPage: 'home',
    greeting, firstName, subtext,
    todaysShifts, upcomingShifts, weekDays, stats, onShift,
    recentClocks, compliance, member, employee, today,
    cards, streaks, prefs, timeline, weather,
  });
});

// POST /w/home/cards/:id/dismiss — dismiss a smart card
router.post('/home/cards/:id/dismiss', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE home_cards SET dismissed_at = datetime('now') WHERE id = ? AND crew_member_id = ?")
    .run(req.params.id, req.session.worker.id);
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true });
  res.redirect('/w/home');
});

// POST /w/home/cards/:id/act — mark a card as acted on (when CTA clicked)
router.post('/home/cards/:id/act', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE home_cards SET acted_at = datetime('now') WHERE id = ? AND crew_member_id = ?")
    .run(req.params.id, req.session.worker.id);
  res.json({ ok: true });
});

// POST /w/home/preferences — save Customise Home settings
router.post('/home/preferences', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const sectionOrder = Array.isArray(req.body.section_order) ? req.body.section_order : (req.body.section_order ? [].concat(req.body.section_order) : null);
  const hiddenSections = Array.isArray(req.body.hidden_sections) ? req.body.hidden_sections : (req.body.hidden_sections ? [].concat(req.body.hidden_sections) : []);
  const fabActions = Array.isArray(req.body.fab_actions) ? req.body.fab_actions : (req.body.fab_actions ? [].concat(req.body.fab_actions) : null);

  db.prepare(`
    INSERT INTO home_preferences (crew_member_id, section_order, hidden_sections, fab_actions, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(crew_member_id) DO UPDATE SET
      section_order = excluded.section_order,
      hidden_sections = excluded.hidden_sections,
      fab_actions = excluded.fab_actions,
      updated_at = excluded.updated_at
  `).run(
    worker.id,
    JSON.stringify(sectionOrder || []),
    JSON.stringify(hiddenSections || []),
    JSON.stringify(fabActions || [])
  );

  req.flash('success', 'Home preferences saved.');
  res.redirect('/w/home/customise');
});

// GET /w/home/customise — Customise Home settings page
router.get('/home/customise', (req, res) => {
  const db = getDb();
  const prefs = loadPreferences(db, req.session.worker);
  res.render('worker/home-customise', {
    title: 'Customise Home', currentPage: 'more',
    prefs,
    flash_success: req.flash('success'),
  });
});

module.exports = router;
