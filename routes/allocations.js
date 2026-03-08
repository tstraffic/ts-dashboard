const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const {
  checkAllocationBlocks,
  getComplianceStatusBatch,
  getBatchFatigue,
  tcpLevelMeetsRequirement,
} = require('../middleware/compliance');

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

    const jobs = db.prepare(`
      SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status, j.required_tcp_level
      FROM jobs j
      WHERE j.status IN ('active','on_hold','won')
      ORDER BY j.job_number ASC
    `).all();

    const allocCounts = db.prepare(`
      SELECT job_id, allocation_date, COUNT(*) as cnt
      FROM crew_allocations
      WHERE allocation_date BETWEEN ? AND ?
      AND status IN ('allocated','confirmed')
      GROUP BY job_id, allocation_date
    `).all(weekStart, weekEnd);

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
      allocations: [],
      equipmentAssignments: [],
      crewMembers: [],
      stats: { jobsToday: jobs.length, crewAllocated: 0, unconfirmed: 0, gaps: 0 },
      userRole: req.session.user.role,
    });
  }

  // Day view
  const jobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status,
      j.required_tcp_level, u.full_name as pm_name
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

  // Active crew with compliance status for crew panel
  const crewMembersRaw = db.prepare('SELECT * FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const fatigueMap = getBatchFatigue(selectedDate);

  // Count how many times each crew member is already allocated today
  const allocCountMap = {};
  for (const a of allocations) {
    allocCountMap[a.crew_member_id] = (allocCountMap[a.crew_member_id] || 0) + 1;
  }

  const crewMembers = crewMembersRaw.map(m => ({
    ...m,
    compliance: getComplianceStatusBatch(m, fatigueMap, selectedDate),
    allocatedToday: allocCountMap[m.id] || 0,
  }));

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
    stats: { jobsToday: jobs.length, crewAllocated, unconfirmed, gaps },
    weekDays: [],
    allocMap: {},
    userRole: req.session.user.role,
  });
});

// POST / — Create allocation (with blocking)
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, force_override } = req.body;

  const check = checkAllocationBlocks(
    parseInt(crew_member_id), parseInt(job_id),
    allocation_date, start_time || '06:00', end_time || '14:30', null
  );

  // If blocks exist and no override, reject
  if (!check.allowed && !force_override) {
    for (const b of check.blocks) req.flash('error', 'BLOCKED: ' + b);
    for (const w of check.warnings) req.flash('error', w);
    return res.redirect('/allocations?date=' + allocation_date);
  }

  // If override requested, check authorisation
  if (!check.allowed && force_override) {
    const userRole = req.session.user.role;
    if (userRole !== 'management' && userRole !== 'operations') {
      req.flash('error', 'Only Management or Operations can override allocation blocks');
      return res.redirect('/allocations?date=' + allocation_date);
    }
    logActivity({
      user: req.session.user, action: 'update', entityType: 'allocation_override',
      jobId: parseInt(job_id),
      details: 'Override: ' + check.blocks.join('; '), ip: req.ip,
    });
  }

  // Show warnings (non-blocking)
  for (const w of check.warnings) req.flash('error', w);

  db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(job_id), parseInt(crew_member_id), allocation_date,
    start_time || '06:00', end_time || '14:30', shift_type || 'day',
    role_on_site || '', notes || '', req.session.user.id
  );

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    jobId: parseInt(job_id), details: 'Allocated crew to job on ' + allocation_date, ip: req.ip });

  if (check.blocks.length === 0 && check.warnings.length === 0) {
    req.flash('success', 'Crew member allocated successfully');
  }

  res.redirect('/allocations?date=' + allocation_date);
});

// ============================================================
// JSON API endpoints for drag-and-drop booking board
// ============================================================

// GET /api/crew-panel.json — Crew list with compliance status
router.get('/api/crew-panel.json', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const crewRaw = db.prepare('SELECT * FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const fatigueMap = getBatchFatigue(date);

  // Count allocations per crew for the date
  const allocs = db.prepare(`
    SELECT crew_member_id, COUNT(*) as cnt FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
    GROUP BY crew_member_id
  `).all(date);
  const allocCounts = {};
  for (const a of allocs) allocCounts[a.crew_member_id] = a.cnt;

  const crew = crewRaw.map(m => {
    const c = getComplianceStatusBatch(m, fatigueMap, date);
    return {
      id: m.id,
      full_name: m.full_name,
      role: m.role,
      tcp_level: m.tcp_level,
      canAllocate: c.canAllocate,
      fatigueBlocked: c.fatigueBlocked,
      inductionComplete: c.inductionComplete,
      allTicketsValid: c.allTicketsValid,
      supervisorApproved: c.supervisorApproved,
      missingDocs: c.missingDocs,
      daysWorked: c.daysWorked,
      allocatedToday: allocCounts[m.id] || 0,
    };
  });

  res.json(crew);
});

// POST /api/allocate.json — Create allocation via drag-drop
router.post('/api/allocate.json', (req, res) => {
  const db = getDb();
  const { job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, force_override } = req.body;

  const check = checkAllocationBlocks(
    parseInt(crew_member_id), parseInt(job_id),
    allocation_date, start_time || '06:00', end_time || '14:30', null
  );

  if (!check.allowed && !force_override) {
    return res.json({ success: false, blocks: check.blocks, warnings: check.warnings, overridable: check.overridable });
  }

  if (!check.allowed && force_override) {
    const userRole = req.session.user.role;
    if (userRole !== 'management' && userRole !== 'operations') {
      return res.json({ success: false, blocks: ['Unauthorised to override'], warnings: [] });
    }
    logActivity({
      user: req.session.user, action: 'update', entityType: 'allocation_override',
      jobId: parseInt(job_id),
      details: 'Override (drag-drop): ' + check.blocks.join('; '), ip: req.ip,
    });
  }

  const result = db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(job_id), parseInt(crew_member_id), allocation_date,
    start_time || '06:00', end_time || '14:30', shift_type || 'day',
    role_on_site || '', notes || '', req.session.user.id
  );

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    jobId: parseInt(job_id), details: 'Allocated crew via board on ' + allocation_date, ip: req.ip });

  // Fetch the new allocation with crew info for the UI
  const alloc = db.prepare(`
    SELECT ca.*, cm.full_name, cm.role, cm.tcp_level
    FROM crew_allocations ca JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.id = ?
  `).get(result.lastInsertRowid);

  res.json({ success: true, allocationId: result.lastInsertRowid, allocation: alloc, warnings: check.warnings });
});

// POST /api/move.json — Move allocation between jobs
router.post('/api/move.json', (req, res) => {
  const db = getDb();
  const { allocation_id, new_job_id } = req.body;

  const alloc = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(allocation_id);
  if (!alloc) return res.json({ success: false, blocks: ['Allocation not found'] });

  const check = checkAllocationBlocks(
    alloc.crew_member_id, parseInt(new_job_id),
    alloc.allocation_date, alloc.start_time, alloc.end_time, alloc.id
  );

  if (!check.allowed) {
    return res.json({ success: false, blocks: check.blocks, warnings: check.warnings });
  }

  db.prepare('UPDATE crew_allocations SET job_id = ?, status = ? WHERE id = ?')
    .run(parseInt(new_job_id), 'allocated', allocation_id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(allocation_id), jobId: parseInt(new_job_id),
    details: 'Moved allocation to new job', ip: req.ip });

  res.json({ success: true, warnings: check.warnings });
});

// DELETE /api/:id.json — Remove allocation
router.delete('/api/:id.json', (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM crew_allocations WHERE id = ? AND status = 'allocated'").run(req.params.id);
  if (result.changes > 0) {
    logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_allocation',
      entityId: parseInt(req.params.id), details: 'Removed allocation via board', ip: req.ip });
  }
  res.json({ success: result.changes > 0 });
});

// ============================================================
// Standard form-based endpoints (kept for fallback)
// ============================================================

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
  res.redirect('/allocations?date=' + date);
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
  res.redirect('/allocations?date=' + date);
});

// POST /:id/delete — Delete allocation (only if still allocated)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    DELETE FROM crew_allocations WHERE id = ? AND status = 'allocated'
  `).run(req.params.id);

  req.flash('success', 'Allocation removed');
  res.redirect('/allocations?date=' + date);
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
    details: 'Bulk confirmed ' + result.changes + ' allocations for ' + allocation_date, ip: req.ip });
  req.flash('success', result.changes + ' allocations confirmed');
  res.redirect('/allocations?date=' + allocation_date);
});

// POST /copy-day — Copy allocations from one day to another
router.post('/copy-day', (req, res) => {
  const db = getDb();
  const { from_date, to_date } = req.body;

  const existingCount = db.prepare(`
    SELECT COUNT(*) as count FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).get(to_date).count;

  if (existingCount > 0) {
    req.flash('error', to_date + ' already has ' + existingCount + ' allocations. Clear them first or allocate manually.');
    return res.redirect('/allocations?date=' + to_date);
  }

  const result = db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, notes, allocated_by_id)
    SELECT job_id, crew_member_id, ?, start_time, end_time, shift_type, role_on_site, 'allocated', notes, ?
    FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).run(to_date, req.session.user.id, from_date);

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    details: 'Copied ' + result.changes + ' allocations from ' + from_date + ' to ' + to_date, ip: req.ip });
  req.flash('success', result.changes + ' allocations copied from ' + from_date + ' to ' + to_date);
  res.redirect('/allocations?date=' + to_date);
});

module.exports = router;
