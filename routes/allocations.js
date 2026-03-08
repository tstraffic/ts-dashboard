const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// Helper: check time overlap
function timesOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

// Helper: run conflict checks before allocation
function checkConflicts(db, crewMemberId, allocationDate, startTime, endTime, excludeId) {
  const warnings = [];

  // 1. Double-booking check
  const existing = db.prepare(`
    SELECT ca.id, ca.start_time, ca.end_time, j.job_number
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ?
    AND ca.status IN ('allocated','confirmed')
    ${excludeId ? 'AND ca.id != ?' : ''}
  `).all(...(excludeId ? [crewMemberId, allocationDate, excludeId] : [crewMemberId, allocationDate]));

  for (const ea of existing) {
    if (timesOverlap(startTime, endTime, ea.start_time, ea.end_time)) {
      warnings.push(`Double-booking: already allocated to ${ea.job_number} on this date (${ea.start_time}-${ea.end_time})`);
    }
  }

  // 2. Fatigue check — count days worked in last 7 days
  const fatigue = db.prepare(`
    SELECT COUNT(DISTINCT d.work_day) as consecutive_days FROM (
      SELECT allocation_date as work_day FROM crew_allocations
      WHERE crew_member_id = ? AND status IN ('allocated','confirmed')
      AND allocation_date BETWEEN date(?, '-6 days') AND date(?, '-1 day')
      UNION
      SELECT work_date as work_day FROM timesheets
      WHERE crew_member_id = ?
      AND work_date BETWEEN date(?, '-6 days') AND date(?, '-1 day')
    ) d
  `).get(crewMemberId, allocationDate, allocationDate, crewMemberId, allocationDate, allocationDate);

  if (fatigue.consecutive_days >= 5) {
    warnings.push(`Fatigue risk: ${fatigue.consecutive_days} days worked in last 7 days`);
  }

  // 3. Ticket expiry check
  const crew = db.prepare(`
    SELECT full_name, tc_ticket_expiry, ti_ticket_expiry, white_card_expiry, first_aid_expiry, medical_expiry
    FROM crew_members WHERE id = ?
  `).get(crewMemberId);

  if (crew) {
    const soon = new Date(allocationDate);
    soon.setDate(soon.getDate() + 7);
    const soonStr = soon.toISOString().split('T')[0];

    const checks = [
      { field: 'tc_ticket_expiry', label: 'TC Ticket' },
      { field: 'ti_ticket_expiry', label: 'TI Ticket' },
      { field: 'white_card_expiry', label: 'White Card' },
      { field: 'first_aid_expiry', label: 'First Aid' },
      { field: 'medical_expiry', label: 'Medical' },
    ];
    for (const c of checks) {
      const val = crew[c.field];
      if (val && val < allocationDate) {
        warnings.push(`${crew.full_name}: ${c.label} expired ${val}`);
      } else if (val && val <= soonStr) {
        warnings.push(`${crew.full_name}: ${c.label} expiring ${val}`);
      }
    }
  }

  return warnings;
}

// GET / — Main booking board
router.get('/', (req, res) => {
  const db = getDb();
  const view = req.query.view || 'day';
  const today = new Date().toISOString().split('T')[0];
  const selectedDate = req.query.date || today;

  if (view === 'week') {
    // Calculate Monday of the selected week
    const d = new Date(selectedDate);
    const dayOfWeek = d.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      weekDays.push(day.toISOString().split('T')[0]);
    }

    const weekStart = weekDays[0];
    const weekEnd = weekDays[6];

    // Jobs active during this week
    const jobs = db.prepare(`
      SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status
      FROM jobs j
      WHERE j.status IN ('active','on_hold','won')
      ORDER BY j.job_number ASC
    `).all();

    // Allocation counts per job per day
    const allocCounts = db.prepare(`
      SELECT job_id, allocation_date, COUNT(*) as cnt
      FROM crew_allocations
      WHERE allocation_date BETWEEN ? AND ?
      AND status IN ('allocated','confirmed')
      GROUP BY job_id, allocation_date
    `).all(weekStart, weekEnd);

    // Build lookup: { jobId: { date: count } }
    const allocMap = {};
    for (const row of allocCounts) {
      if (!allocMap[row.job_id]) allocMap[row.job_id] = {};
      allocMap[row.job_id][row.allocation_date] = row.cnt;
    }

    return res.render('allocations/index', {
      title: 'Crew Allocations',
      currentPage: 'allocations',
      view: 'week',
      selectedDate,
      today,
      weekDays,
      jobs,
      allocMap,
      // not needed in week view but keep template happy
      allocations: [],
      equipmentAssignments: [],
      crewMembers: [],
      stats: { jobsToday: jobs.length, crewAllocated: 0, unconfirmed: 0, gaps: 0 }
    });
  }

  // Day view
  const jobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status,
      u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status IN ('active','on_hold','won')
    ORDER BY j.job_number ASC
  `).all();

  // Crew allocations for the selected date
  const allocations = db.prepare(`
    SELECT ca.*, cm.full_name, cm.role, cm.tcp_level,
      cm.tc_ticket_expiry, cm.ti_ticket_expiry, cm.white_card_expiry, cm.first_aid_expiry, cm.medical_expiry
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.job_id, cm.full_name
  `).all(selectedDate);

  // Equipment assignments active on selected date
  const equipmentAssignments = db.prepare(`
    SELECT ea.*, e.name as equipment_name, e.asset_number, e.category
    FROM equipment_assignments ea
    JOIN equipment e ON ea.equipment_id = e.id
    WHERE ea.assigned_date <= ? AND (ea.actual_return_date IS NULL OR ea.actual_return_date >= ?)
    ORDER BY ea.job_id
  `).all(selectedDate, selectedDate);

  // Active crew for dropdown
  const crewMembers = db.prepare(`
    SELECT id, full_name, role, tcp_level FROM crew_members WHERE active = 1 ORDER BY full_name
  `).all();

  // Stats
  const crewAllocated = new Set(allocations.map(a => a.crew_member_id)).size;
  const unconfirmed = allocations.filter(a => a.status === 'allocated').length;
  const jobAllocCounts = {};
  for (const a of allocations) {
    jobAllocCounts[a.job_id] = (jobAllocCounts[a.job_id] || 0) + 1;
  }
  const gaps = jobs.filter(j => j.crew_size > 0 && (jobAllocCounts[j.id] || 0) < j.crew_size).length;

  res.render('allocations/index', {
    title: 'Crew Allocations',
    currentPage: 'allocations',
    view: 'day',
    selectedDate,
    today,
    jobs,
    allocations,
    equipmentAssignments,
    crewMembers,
    stats: {
      jobsToday: jobs.length,
      crewAllocated,
      unconfirmed,
      gaps
    },
    // not needed in day view
    weekDays: [],
    allocMap: {}
  });
});

// POST / — Create allocation
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes } = req.body;

  // Conflict checks (non-blocking — add as warnings)
  const warnings = checkConflicts(db, parseInt(crew_member_id), allocation_date, start_time || '06:00', end_time || '14:30', null);

  for (const w of warnings) {
    req.flash('error', w);
  }

  db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(job_id), parseInt(crew_member_id), allocation_date,
    start_time || '06:00', end_time || '14:30', shift_type || 'day',
    role_on_site || '', notes || '', req.session.user.id
  );

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    jobId: parseInt(job_id), details: `Allocated crew to job on ${allocation_date}`, ip: req.ip });

  if (warnings.length === 0) {
    req.flash('success', 'Crew member allocated successfully');
  }

  res.redirect(`/allocations?date=${allocation_date}`);
});

// POST /:id/confirm — Confirm allocation
router.post('/:id/confirm', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(req.params.id), details: 'Confirmed allocation', ip: req.ip });
  req.flash('success', 'Allocation confirmed');
  res.redirect(`/allocations?date=${date}`);
});

// POST /:id/cancel — Cancel allocation
router.post('/:id/cancel', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    UPDATE crew_allocations SET status = 'cancelled' WHERE id = ?
  `).run(req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(req.params.id), details: 'Cancelled allocation', ip: req.ip });
  req.flash('success', 'Allocation cancelled');
  res.redirect(`/allocations?date=${date}`);
});

// POST /:id/delete — Delete allocation (only if still allocated)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    DELETE FROM crew_allocations WHERE id = ? AND status = 'allocated'
  `).run(req.params.id);

  req.flash('success', 'Allocation removed');
  res.redirect(`/allocations?date=${date}`);
});

// POST /confirm-all — Bulk confirm all for a date
router.post('/confirm-all', (req, res) => {
  const db = getDb();
  const { allocation_date } = req.body;

  const result = db.prepare(`
    UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
    WHERE allocation_date = ? AND status = 'allocated'
  `).run(allocation_date);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    details: `Bulk confirmed ${result.changes} allocations for ${allocation_date}`, ip: req.ip });
  req.flash('success', `${result.changes} allocations confirmed`);
  res.redirect(`/allocations?date=${allocation_date}`);
});

// POST /copy-day — Copy allocations from one day to another
router.post('/copy-day', (req, res) => {
  const db = getDb();
  const { from_date, to_date } = req.body;

  // Check for existing allocations on target date to avoid duplicates
  const existingCount = db.prepare(`
    SELECT COUNT(*) as count FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).get(to_date).count;

  if (existingCount > 0) {
    req.flash('error', `${to_date} already has ${existingCount} allocations. Clear them first or allocate manually.`);
    return res.redirect(`/allocations?date=${to_date}`);
  }

  const result = db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, notes, allocated_by_id)
    SELECT job_id, crew_member_id, ?, start_time, end_time, shift_type, role_on_site, 'allocated', notes, ?
    FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).run(to_date, req.session.user.id, from_date);

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    details: `Copied ${result.changes} allocations from ${from_date} to ${to_date}`, ip: req.ip });
  req.flash('success', `${result.changes} allocations copied from ${from_date} to ${to_date}`);
  res.redirect(`/allocations?date=${to_date}`);
});

module.exports = router;
