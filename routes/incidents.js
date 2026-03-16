const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// Helper to generate next incident number
function nextIncidentNumber(db) {
  const last = db.prepare("SELECT incident_number FROM incidents ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'INC-00001';
  const num = parseInt(last.incident_number.replace('INC-', '')) + 1;
  return 'INC-' + String(num).padStart(5, '0');
}

// LIST
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];

  if (req.query.job_id) { where.push('i.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.incident_type) { where.push('i.incident_type = ?'); params.push(req.query.incident_type); }
  if (req.query.severity) { where.push('i.severity = ?'); params.push(req.query.severity); }
  if (req.query.status) { where.push('i.investigation_status = ?'); params.push(req.query.status); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const incidents = db.prepare(`
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name,
      (SELECT COUNT(*) FROM corrective_actions ca WHERE ca.incident_id = i.id) as corrective_action_count,
      (SELECT COUNT(*) FROM corrective_actions ca2 WHERE ca2.incident_id = i.id AND ca2.status != 'completed') as open_actions
    FROM incidents i
    JOIN jobs j ON i.job_id = j.id
    JOIN users u ON i.reported_by_id = u.id
    ${whereClause}
    ORDER BY i.incident_date DESC
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  const today = new Date().toISOString().split('T')[0];

  // Compute stats
  const allIncidents = db.prepare('SELECT severity, investigation_status, incident_date, close_out_date FROM incidents').all();
  const openActions = db.prepare("SELECT COUNT(*) as count FROM corrective_actions WHERE status != 'completed'").get().count;
  const stats = {
    total: allIncidents.length,
    open: allIncidents.filter(i => ['reported', 'investigating'].includes(i.investigation_status)).length,
    critical: allIncidents.filter(i => ['critical', 'high'].includes(i.severity) && ['reported', 'investigating'].includes(i.investigation_status)).length,
    thisMonth: allIncidents.filter(i => i.incident_date && i.incident_date >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]).length,
    openActions,
  };

  res.render('incidents/index', {
    title: 'Safety & Incidents',
    currentPage: 'incidents',
    incidents,
    jobs,
    filters: req.query,
    stats,
    today,
  });
});

// Inline status change
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const valid = ['reported', 'investigating', 'resolved', 'closed'];
  if (!valid.includes(status)) { req.flash('error', 'Invalid status'); return res.redirect('/incidents'); }
  db.prepare('UPDATE incidents SET investigation_status = ? WHERE id = ?').run(status, req.params.id);
  res.redirect('/incidents');
});

// NEW FORM
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const crewMembers = db.prepare("SELECT id, full_name, role FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.render('incidents/form', {
    title: 'Report Incident',
    currentPage: 'incidents',
    incident: null,
    jobs,
    crewMembers,
    linkedCrew: [],
    preselectedJobId: req.query.job_id || ''
  });
});

// CREATE
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date } = req.body;
  const incident_number = nextIncidentNumber(db);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  const result = db.prepare(`
    INSERT INTO incidents (job_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, persons_involved, witnesses, immediate_actions, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job_id, incident_number, incident_type, severity || 'low', title, description, location || '', incident_date, incident_time || '', req.session.user.id, persons_involved || '', witnesses || '', immediate_actions || '', notifiable_incident ? 1 : 0, traffic_disruption ? 1 : 0, police_notified ? 1 : 0, client_notified ? 1 : 0, close_out_date || null);

  const incidentId = result.lastInsertRowid;

  // Save linked crew members
  const crewIds = Array.isArray(req.body.crew_member_ids) ? req.body.crew_member_ids : (req.body.crew_member_ids ? [req.body.crew_member_ids] : []);
  const crewTypes = Array.isArray(req.body.crew_involvement_types) ? req.body.crew_involvement_types : (req.body.crew_involvement_types ? [req.body.crew_involvement_types] : []);
  const insertCrew = db.prepare('INSERT OR IGNORE INTO incident_crew_members (incident_id, crew_member_id, involvement_type) VALUES (?, ?, ?)');
  for (let i = 0; i < crewIds.length; i++) {
    if (crewIds[i]) {
      insertCrew.run(incidentId, parseInt(crewIds[i]), crewTypes[i] || 'involved');
    }
  }

  logActivity({ user: req.session.user, action: 'create', entityType: 'incident', entityId: incidentId, entityLabel: `${incident_number} - ${title}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', details: `Severity: ${severity}, Type: ${incident_type}`, ip: req.ip });

  req.flash('success', `Incident ${incident_number} reported successfully.`);
  res.redirect(`/incidents/${incidentId}`);
});

// SHOW
router.get('/:id', (req, res) => {
  const db = getDb();
  const incident = db.prepare(`
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name
    FROM incidents i
    JOIN jobs j ON i.job_id = j.id
    JOIN users u ON i.reported_by_id = u.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!incident) {
    req.flash('error', 'Incident not found.');
    return res.redirect('/incidents');
  }

  const correctiveActions = db.prepare(`
    SELECT ca.*, u.full_name as assigned_to_name
    FROM corrective_actions ca
    LEFT JOIN users u ON ca.assigned_to_id = u.id
    WHERE ca.incident_id = ?
    ORDER BY ca.due_date ASC
  `).all(req.params.id);

  const linkedCrew = db.prepare(`
    SELECT icm.*, cm.full_name, cm.role, cm.employee_id
    FROM incident_crew_members icm
    JOIN crew_members cm ON icm.crew_member_id = cm.id
    WHERE icm.incident_id = ?
    ORDER BY cm.full_name
  `).all(req.params.id);

  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  res.render('incidents/show', {
    title: `Incident ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    correctiveActions,
    linkedCrew,
    users
  });
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) {
    req.flash('error', 'Incident not found.');
    return res.redirect('/incidents');
  }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const crewMembers = db.prepare("SELECT id, full_name, role FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  const linkedCrew = db.prepare(`
    SELECT icm.crew_member_id, icm.involvement_type
    FROM incident_crew_members icm
    WHERE icm.incident_id = ?
  `).all(req.params.id);
  res.render('incidents/form', {
    title: `Edit ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    jobs,
    crewMembers,
    linkedCrew,
    preselectedJobId: ''
  });
});

// UPDATE
router.post('/:id', (req, res) => {
  const db = getDb();
  const { job_id, incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, root_cause, investigation_status, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);
  const existing = db.prepare('SELECT incident_number FROM incidents WHERE id = ?').get(req.params.id);

  db.prepare(`
    UPDATE incidents SET job_id=?, incident_type=?, severity=?, title=?, description=?, location=?, incident_date=?, incident_time=?, persons_involved=?, witnesses=?, immediate_actions=?, root_cause=?, investigation_status=?, notifiable_incident=?, traffic_disruption=?, police_notified=?, client_notified=?, close_out_date=?, updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(job_id, incident_type, severity, title, description, location || '', incident_date, incident_time || '', persons_involved || '', witnesses || '', immediate_actions || '', root_cause || '', investigation_status, notifiable_incident ? 1 : 0, traffic_disruption ? 1 : 0, police_notified ? 1 : 0, client_notified ? 1 : 0, close_out_date || null, req.params.id);

  // Sync linked crew members: delete existing, re-insert
  db.prepare('DELETE FROM incident_crew_members WHERE incident_id = ?').run(req.params.id);
  const crewIds = Array.isArray(req.body.crew_member_ids) ? req.body.crew_member_ids : (req.body.crew_member_ids ? [req.body.crew_member_ids] : []);
  const crewTypes = Array.isArray(req.body.crew_involvement_types) ? req.body.crew_involvement_types : (req.body.crew_involvement_types ? [req.body.crew_involvement_types] : []);
  const insertCrew = db.prepare('INSERT OR IGNORE INTO incident_crew_members (incident_id, crew_member_id, involvement_type) VALUES (?, ?, ?)');
  for (let i = 0; i < crewIds.length; i++) {
    if (crewIds[i]) {
      insertCrew.run(parseInt(req.params.id), parseInt(crewIds[i]), crewTypes[i] || 'involved');
    }
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'incident', entityId: parseInt(req.params.id), entityLabel: existing ? existing.incident_number : title, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });

  req.flash('success', 'Incident updated.');
  res.redirect(`/incidents/${req.params.id}`);
});

// DELETE
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (incident) {
    db.prepare('DELETE FROM incidents WHERE id = ?').run(req.params.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'incident', entityId: parseInt(req.params.id), entityLabel: incident.incident_number, jobId: incident.job_id, ip: req.ip });
  }
  req.flash('success', 'Incident deleted.');
  res.redirect('/incidents');
});

// ADD CORRECTIVE ACTION
router.post('/:id/corrective-actions', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) { req.flash('error', 'Incident not found.'); return res.redirect('/incidents'); }

  const { description, assigned_to_id, due_date, priority } = req.body;
  const result = db.prepare(`
    INSERT INTO corrective_actions (incident_id, job_id, description, assigned_to_id, due_date, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, incident.job_id, description, assigned_to_id || null, due_date, priority || 'medium');

  logActivity({ user: req.session.user, action: 'create', entityType: 'corrective_action', entityId: result.lastInsertRowid, entityLabel: description.substring(0, 60), jobId: incident.job_id, ip: req.ip });

  req.flash('success', 'Corrective action added.');
  res.redirect(`/incidents/${req.params.id}`);
});

// COMPLETE CORRECTIVE ACTION
router.post('/:id/corrective-actions/:caId/complete', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`
    UPDATE corrective_actions SET status='completed', completed_date=?, completion_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(today, req.body.completion_notes || '', req.params.caId);

  logActivity({ user: req.session.user, action: 'complete', entityType: 'corrective_action', entityId: parseInt(req.params.caId), ip: req.ip });

  req.flash('success', 'Corrective action completed.');
  res.redirect(`/incidents/${req.params.id}`);
});

module.exports = router;
