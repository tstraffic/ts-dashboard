const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { requireRole } = require('../middleware/auth');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { workerInviteEmail } = require('../services/emailTemplates');
const {
  getComplianceStatus,
  getComplianceStatusBatch,
  getBatchFatigue,
} = require('../middleware/compliance');

// GET / — Workforce Roster
router.get('/', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const filter = req.query.filter || 'all'; // all | active | blocked | fatigued | expiring
  const roleFilter = req.query.role || '';
  const search = (req.query.search || '').trim().toLowerCase();

  // Fetch all crew (active + inactive)
  let crew = db.prepare(`
    SELECT * FROM crew_members ORDER BY active DESC, full_name ASC
  `).all();

  // Batch: active allocation counts per crew member (today or future, not cancelled)
  const allocCountRows = db.prepare(`
    SELECT crew_member_id, COUNT(*) as cnt
    FROM crew_allocations
    WHERE allocation_date >= ? AND status != 'cancelled'
    GROUP BY crew_member_id
  `).all(today);
  const allocCountMap = {};
  allocCountRows.forEach(r => { allocCountMap[r.crew_member_id] = r.cnt; });

  // Batch: last worked date per crew member (from timesheets)
  const lastWorkedRows = db.prepare(`
    SELECT crew_member_id, MAX(work_date) as last_worked
    FROM timesheets
    GROUP BY crew_member_id
  `).all();
  const lastWorkedMap = {};
  lastWorkedRows.forEach(r => { lastWorkedMap[r.crew_member_id] = r.last_worked; });

  // Batch fatigue lookup for performance
  const fatigueMap = getBatchFatigue(today);

  // Compute nearest expiry from all date fields
  function getNearestExpiry(m) {
    const fields = [
      { label: 'Licence', date: m.licence_expiry },
      { label: 'White Card', date: m.white_card_expiry },
      { label: 'Medical', date: m.medical_expiry },
      { label: 'TC Ticket', date: m.tc_ticket_expiry },
      { label: 'TI Ticket', date: m.ti_ticket_expiry },
      { label: 'First Aid', date: m.first_aid_expiry },
    ];
    let nearest = null;
    for (const f of fields) {
      if (f.date && (!nearest || f.date < nearest.date)) {
        nearest = { label: f.label, date: f.date };
      }
    }
    return nearest;
  }

  // Compute compliance status for each + enrich with extra data
  const crewWithStatus = crew.map(m => {
    const nearestExpiry = getNearestExpiry(m);
    return {
      ...m,
      compliance: getComplianceStatusBatch(m, fatigueMap, today),
      activeJobs: allocCountMap[m.id] || 0,
      lastWorked: lastWorkedMap[m.id] || null,
      nearestExpiry,
    };
  });

  // 30-day expiry window for "expiring" filter
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  const expiryThreshold = thirtyDaysOut.toISOString().split('T')[0];

  // Apply filters
  let filtered = crewWithStatus;
  if (filter === 'active') {
    filtered = filtered.filter(c => c.active);
  } else if (filter === 'blocked') {
    filtered = filtered.filter(c => c.active && !c.compliance.canAllocate);
  } else if (filter === 'fatigued') {
    filtered = filtered.filter(c => c.compliance.fatigueBlocked);
  } else if (filter === 'expiring') {
    filtered = filtered.filter(c => c.active && c.nearestExpiry && c.nearestExpiry.date <= expiryThreshold);
  }

  // Apply role filter
  if (roleFilter) {
    filtered = filtered.filter(c => c.role === roleFilter);
  }

  // Apply search
  if (search) {
    filtered = filtered.filter(c =>
      c.full_name.toLowerCase().includes(search) ||
      (c.employee_id || '').toLowerCase().includes(search) ||
      (c.role || '').toLowerCase().includes(search) ||
      (c.company || '').toLowerCase().includes(search)
    );
  }

  // Sorting
  const allowedSorts = ['full_name', 'employee_id', 'role', 'licence_expiry'];
  const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'full_name';
  const order = req.query.order === 'desc' ? 'desc' : 'asc';
  filtered.sort((a, b) => {
    let valA = a[sort] || '';
    let valB = b[sort] || '';
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });

  // Stats
  const totalActive = crewWithStatus.filter(c => c.active).length;
  const allocatable = crewWithStatus.filter(c => c.active && c.compliance.canAllocate).length;
  const complianceIssues = crewWithStatus.filter(c => c.active && (!c.compliance.allTicketsValid || !c.compliance.licenceValid || !c.compliance.inductionComplete)).length;
  const fatigueBlocked = crewWithStatus.filter(c => c.compliance.fatigueBlocked).length;
  const expiringSoon = crewWithStatus.filter(c => c.active && c.nearestExpiry && c.nearestExpiry.date <= expiryThreshold).length;

  res.render('crew/index', {
    title: 'Workforce',
    currentPage: 'crew',
    crew: filtered,
    filter,
    roleFilter,
    search: req.query.search || '',
    stats: { totalActive, allocatable, complianceIssues, fatigueBlocked, expiringSoon },
    today,
    sort,
    order,
  });
});

// GET /new — Add Crew Member form
router.get('/new', (req, res) => {
  res.render('crew/form', { title: 'Add Crew Member', currentPage: 'crew', editMember: null });
});

// POST / — Create Crew Member
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, role, tcp_level, phone, email, company, employment_type, hourly_rate, licence_type, licence_expiry, white_card, white_card_expiry, induction_date, medical_expiry, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.full_name, b.employee_id || null, b.role, b.tcp_level || '', b.phone || '', b.email || '',
      b.company || '', b.employment_type || 'employee', parseFloat(b.hourly_rate) || 0,
      b.licence_type || '', b.licence_expiry || null, b.white_card || '', b.white_card_expiry || null,
      b.induction_date || null, b.medical_expiry || null, b.active ? 1 : 0
    );
    logActivity({ user: req.session.user, action: 'create', entityType: 'crew_member', entityId: result.lastInsertRowid, entityLabel: b.full_name, details: 'Added crew member', ip: req.ip });
    req.flash('success', b.full_name + ' added to workforce.');
    res.redirect('/crew/' + result.lastInsertRowid);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', 'Employee ID "' + b.employee_id + '" already exists.');
    } else {
      req.flash('error', 'Failed to add crew member: ' + err.message);
    }
    res.redirect('/crew/new');
  }
});

// POST /bulk — Bulk actions on crew members
router.post('/bulk', (req, res) => {
  const db = getDb();
  const ids = (req.body.ids || '').split(',').map(Number).filter(n => n > 0);
  const action = req.body.action;
  if (ids.length === 0) return res.redirect('/crew');

  if (action === 'deactivate') {
    const stmt = db.prepare('UPDATE crew_members SET active = 0 WHERE id = ?');
    ids.forEach(id => stmt.run(id));
    logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityLabel: `Bulk deactivated ${ids.length} crew members`, ip: req.ip });
    req.flash('success', ids.length + ' crew member(s) deactivated.');
  }
  res.redirect('/crew');
});

// GET /:id/edit — Edit Crew Member form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const editMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!editMember) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  res.render('crew/form', { title: 'Edit ' + editMember.full_name, currentPage: 'crew', editMember });
});

// POST /:id — Update Crew Member
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  try {
    db.prepare(`
      UPDATE crew_members SET full_name=?, employee_id=?, role=?, tcp_level=?, phone=?, email=?, company=?, employment_type=?, hourly_rate=?, licence_type=?, licence_expiry=?, white_card=?, white_card_expiry=?, induction_date=?, medical_expiry=?, active=? WHERE id=?
    `).run(
      b.full_name, b.employee_id || null, b.role, b.tcp_level || '', b.phone || '', b.email || '',
      b.company || '', b.employment_type || 'employee', parseFloat(b.hourly_rate) || 0,
      b.licence_type || '', b.licence_expiry || null, b.white_card || '', b.white_card_expiry || null,
      b.induction_date || null, b.medical_expiry || null, b.active ? 1 : 0, req.params.id
    );
    logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: member.id, entityLabel: b.full_name, details: 'Updated crew member details', ip: req.ip });
    req.flash('success', b.full_name + ' updated.');
    res.redirect('/crew/' + member.id);
  } catch (err) {
    req.flash('error', 'Failed to update: ' + err.message);
    res.redirect('/crew/' + member.id + '/edit');
  }
});

// GET /:id — Worker Profile
router.get('/:id', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);

  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const compliance = getComplianceStatus(member, today);

  // Upcoming allocations
  const upcomingShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.client, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date >= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
    LIMIT 30
  `).all(member.id, today);

  // Recent timesheets
  const recentTimesheets = db.prepare(`
    SELECT t.*, j.job_number, j.client,
      u.full_name as approved_by_name
    FROM timesheets t
    JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.approved_by_id = u.id
    WHERE t.crew_member_id = ?
    ORDER BY t.work_date DESC
    LIMIT 20
  `).all(member.id);

  // Linked incidents (structured + free-text search)
  const linkedIncidents = db.prepare(`
    SELECT DISTINCT i.id, i.incident_number, i.incident_date, i.incident_type,
      i.severity, i.title, i.investigation_status,
      icm.involvement_type
    FROM incidents i
    LEFT JOIN incident_crew_members icm ON icm.incident_id = i.id AND icm.crew_member_id = ?
    WHERE icm.id IS NOT NULL
    OR i.persons_involved LIKE ? OR i.witnesses LIKE ?
    ORDER BY i.incident_date DESC
    LIMIT 20
  `).all(member.id, '%' + member.full_name + '%', '%' + member.full_name + '%');

  // Supervisor who approved (if any)
  let approvedBy = null;
  if (member.supervisor_approved_by_id) {
    approvedBy = db.prepare('SELECT full_name FROM users WHERE id = ?').get(member.supervisor_approved_by_id);
  }

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'crew_member' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  res.render('crew/show', {
    title: member.full_name + ' — Worker Profile',
    currentPage: 'crew',
    member,
    compliance,
    upcomingShifts,
    recentTimesheets,
    linkedIncidents,
    activities,
    approvedBy: approvedBy ? approvedBy.full_name : null,
    today,
  });
});

// POST /:id/delete — Delete Crew Member
router.post('/:id/delete', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }

  // Check for linked records
  const allocations = db.prepare('SELECT COUNT(*) as count FROM crew_allocations WHERE crew_member_id = ?').get(req.params.id).count;
  const timesheets = db.prepare('SELECT COUNT(*) as count FROM timesheets WHERE crew_member_id = ?').get(req.params.id).count;
  if (allocations > 0 || timesheets > 0) {
    req.flash('error', `Cannot delete ${member.full_name} — they have ${allocations} allocation(s) and ${timesheets} timesheet(s). Deactivate instead.`);
    return res.redirect('/crew/' + member.id);
  }

  db.prepare('DELETE FROM crew_members WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Deleted crew member', ip: req.ip });
  req.flash('success', member.full_name + ' deleted.');
  res.redirect('/crew');
});

// POST /:id/supervisor-approve — Toggle supervisor approval
router.post('/:id/supervisor-approve', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const newStatus = member.supervisor_approved ? 0 : 1;
  if (newStatus) {
    db.prepare(`
      UPDATE crew_members SET supervisor_approved = 1, supervisor_approved_by_id = ?, supervisor_approved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.session.user.id, member.id);
  } else {
    db.prepare(`
      UPDATE crew_members SET supervisor_approved = 0, supervisor_approved_by_id = NULL, supervisor_approved_at = NULL WHERE id = ?
    `).run(member.id);
  }

  logActivity({
    user: req.session.user,
    action: newStatus ? 'approve' : 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: newStatus ? 'Supervisor approved crew member' : 'Revoked supervisor approval',
    ip: req.ip,
  });

  req.flash('success', newStatus ? member.full_name + ' approved' : 'Approval revoked for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

// POST /:id/set-pin — Set or reset worker portal PIN
router.post('/:id/set-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const { pin } = req.body;

  // Validate PIN: 4-6 digits
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect('/crew/' + member.id);
  }

  // Hash and save
  const pinHash = bcrypt.hashSync(pin, 12);
  db.prepare(`
    UPDATE crew_members SET pin_hash = ?, pin_set_at = CURRENT_TIMESTAMP, pin_set_by_id = ? WHERE id = ?
  `).run(pinHash, req.session.user.id, member.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Set worker portal PIN',
    ip: req.ip,
  });

  req.flash('success', 'Portal PIN set for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

// POST /:id/send-invite — Send email invitation for worker portal
router.post('/:id/send-invite', requireRole('admin', 'operations'), async (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  if (!member.email || !member.employee_id) {
    req.flash('error', 'Crew member needs both an email and Employee ID to receive an invite.');
    return res.redirect('/crew/' + member.id);
  }

  const { token } = createInvitation({ type: 'crew_member', targetId: member.id, email: member.email, createdById: req.session.user.id });
  const setupUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/w/setup/' + token;
  await sendEmail(member.email, 'Set up your T&S Worker Portal PIN', workerInviteEmail(member.full_name, setupUrl, TOKEN_EXPIRY_HOURS));

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Sent worker portal email invitation',
    ip: req.ip,
  });

  req.flash('success', `Invitation email sent to ${member.email}`);
  res.redirect('/crew/' + member.id);
});

// POST /:id/clear-pin — Remove worker portal PIN
router.post('/:id/clear-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  db.prepare(`
    UPDATE crew_members SET pin_hash = NULL, pin_set_at = NULL, pin_set_by_id = NULL WHERE id = ?
  `).run(member.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Cleared worker portal PIN',
    ip: req.ip,
  });

  req.flash('success', 'Portal PIN cleared for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

module.exports = router;
