const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/availability — 4-week availability calendar
router.get('/availability', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Generate next 28 days
  const days = [];
  const today = new Date();
  for (let i = 0; i < 28; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().split('T')[0]);
  }

  // Get existing availability
  const existing = db.prepare(`
    SELECT date, status, shift_preference, notes FROM crew_availability
    WHERE crew_member_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(worker.id, days[0], days[days.length - 1]);

  const availMap = {};
  existing.forEach(a => { availMap[a.date] = a; });

  // Group by week
  const weeks = [];
  for (let i = 0; i < 28; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  res.render('worker/availability', {
    title: 'My Availability',
    currentPage: 'more',
    weeks,
    availMap,
    today: today.toISOString().split('T')[0],
  });
});

// POST /w/availability — Bulk update availability
router.post('/availability', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { dates, statuses, preferences, notes } = req.body;

  if (!dates || !statuses) {
    req.flash('error', 'No availability data submitted.');
    return res.redirect('/w/availability');
  }

  const dateArr = Array.isArray(dates) ? dates : [dates];
  const statusArr = Array.isArray(statuses) ? statuses : [statuses];
  const prefArr = Array.isArray(preferences) ? preferences : [preferences || 'any'];
  const noteArr = Array.isArray(notes) ? notes : [notes || ''];

  const upsert = db.prepare(`
    INSERT INTO crew_availability (crew_member_id, date, status, shift_preference, notes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(crew_member_id, date) DO UPDATE SET status = excluded.status, shift_preference = excluded.shift_preference, notes = excluded.notes
  `);

  const transaction = db.transaction(() => {
    for (let i = 0; i < dateArr.length; i++) {
      upsert.run(worker.id, dateArr[i], statusArr[i] || 'available', prefArr[i] || 'any', noteArr[i] || null);
    }
  });
  transaction();

  req.flash('success', 'Availability updated.');
  res.redirect('/w/availability');
});

module.exports = router;
