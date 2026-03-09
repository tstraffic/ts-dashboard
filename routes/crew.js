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
  const filter = req.query.filter || 'all'; // all | active | blocked | fatigued
  const search = (req.query.search || '').trim().toLowerCase();

  // Fetch all crew (active + inactive)
  let crew = db.prepare(`
    SELECT * FROM crew_members ORDER BY active DESC, full_name ASC
  `).all();

  // Batch fatigue lookup for performance
  const fatigueMap = getBatchFatigue(today);

  // Compute compliance status for each
  const crewWithStatus = crew.map(m => ({
    ...m,
    compliance: getComplianceStatusBatch(m, fatigueMap, today),
  }));

  // Apply filters
  let filtered = crewWithStatus;
  if (filter === 'active') {
    filtered = filtered.filter(c => c.active);
  } else if (filter === 'blocked') {
    filtered = filtered.filter(c => c.active && !c.compliance.canAllocate);
  } else if (filter === 'fatigued') {
    filtered = filtered.filter(c => c.compliance.fatigueBlocked);
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

  // Stats
  const totalActive = crewWithStatus.filter(c => c.active).length;
  const allocatable = crewWithStatus.filter(c => c.active && c.compliance.canAllocate).length;
  const complianceIssues = crewWithStatus.filter(c => c.active && (!c.compliance.allTicketsValid || !c.compliance.licenceValid || !c.compliance.inductionComplete)).length;
  const fatigueBlocked = crewWithStatus.filter(c => c.compliance.fatigueBlocked).length;

  res.render('crew/index', {
    title: 'Workforce',
    currentPage: 'crew',
    crew: filtered,
    filter,
    search: req.query.search || '',
    stats: { totalActive, allocatable, complianceIssues, fatigueBlocked },
  });
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

  res.render('crew/show', {
    title: member.full_name + ' — Worker Profile',
    currentPage: 'crew',
    member,
    compliance,
    upcomingShifts,
    recentTimesheets,
    linkedIncidents,
    approvedBy: approvedBy ? approvedBy.full_name : null,
    today,
  });
});

// POST /:id/supervisor-approve — Toggle supervisor approval
router.post('/:id/supervisor-approve', requireRole('management', 'operations'), (req, res) => {
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
router.post('/:id/set-pin', requireRole('management', 'operations'), (req, res) => {
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
router.post('/:id/send-invite', requireRole('management', 'operations'), async (req, res) => {
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
router.post('/:id/clear-pin', requireRole('management', 'operations'), (req, res) => {
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
