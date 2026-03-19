const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/shifts — My Shifts (today + upcoming 14 days)
router.get('/shifts', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 14);
  const futureDateStr = futureDate.toISOString().split('T')[0];

  const allocations = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date >= ? AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, today, futureDateStr);

  const groupedByDate = {};
  allocations.forEach(a => {
    if (!groupedByDate[a.allocation_date]) groupedByDate[a.allocation_date] = [];
    groupedByDate[a.allocation_date].push(a);
  });

  res.render('worker/shifts', {
    title: 'My Shifts',
    currentPage: 'shifts',
    allocations,
    groupedByDate,
    today,
  });
});

// GET /w/shifts/:id — Shift detail
router.get('/shifts/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      j.notes as job_notes, j.start_date as job_start, j.end_date as job_end,
      u.full_name as supervisor_name, u.email as supervisor_email
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Shift not found or access denied.');
    return res.redirect('/w/shifts');
  }

  const otherCrew = db.prepare(`
    SELECT ca.role_on_site, ca.shift_type, ca.start_time, ca.end_time, ca.status,
      cm.full_name, cm.phone, cm.role as crew_role
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.crew_member_id != ? AND ca.status != 'cancelled'
    ORDER BY cm.full_name ASC
  `).all(allocation.job_id, allocation.allocation_date, worker.id);

  // Check clock status for this allocation
  const lastClock = db.prepare(`
    SELECT * FROM clock_events WHERE crew_member_id = ? AND allocation_id = ? ORDER BY event_time DESC LIMIT 1
  `).get(worker.id, allocation.id);

  res.render('worker/shift-detail', {
    title: allocation.job_name || allocation.job_number,
    currentPage: 'shifts',
    allocation,
    otherCrew,
    lastClock: lastClock || null,
  });
});

// POST /w/shifts/:id/confirm — Worker confirms attendance
router.post('/shifts/:id/confirm', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(req.params.id, worker.id);
  if (!allocation) {
    req.flash('error', 'Shift not found.');
    return res.redirect('/w/shifts');
  }

  db.prepare('UPDATE crew_allocations SET status = ? WHERE id = ?').run('confirmed', req.params.id);
  req.flash('success', 'Shift confirmed.');
  res.redirect('/w/shifts/' + req.params.id);
});

module.exports = router;
