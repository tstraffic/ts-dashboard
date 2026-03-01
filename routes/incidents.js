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
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name
    FROM incidents i
    JOIN jobs j ON i.job_id = j.id
    JOIN users u ON i.reported_by_id = u.id
    ${whereClause}
    ORDER BY i.incident_date DESC
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('incidents/index', {
    title: 'Safety & Incidents',
    currentPage: 'incidents',
    incidents,
    jobs,
    filters: req.query
  });
});

// NEW FORM
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  res.render('incidents/form', {
    title: 'Report Incident',
    currentPage: 'incidents',
    incident: null,
    jobs,
    preselectedJobId: req.query.job_id || ''
  });
});

// CREATE
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, notifiable_incident } = req.body;
  const incident_number = nextIncidentNumber(db);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  const result = db.prepare(`
    INSERT INTO incidents (job_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, persons_involved, witnesses, immediate_actions, notifiable_incident)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job_id, incident_number, incident_type, severity || 'low', title, description, location || '', incident_date, incident_time || '', req.session.user.id, persons_involved || '', witnesses || '', immediate_actions || '', notifiable_incident ? 1 : 0);

  logActivity({ user: req.session.user, action: 'create', entityType: 'incident', entityId: result.lastInsertRowid, entityLabel: `${incident_number} - ${title}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', details: `Severity: ${severity}, Type: ${incident_type}`, ip: req.ip });

  req.flash('success', `Incident ${incident_number} reported successfully.`);
  res.redirect(`/incidents/${result.lastInsertRowid}`);
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

  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  res.render('incidents/show', {
    title: `Incident ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    correctiveActions,
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
  res.render('incidents/form', {
    title: `Edit ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    jobs,
    preselectedJobId: ''
  });
});

// UPDATE
router.post('/:id', (req, res) => {
  const db = getDb();
  const { job_id, incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, root_cause, investigation_status, notifiable_incident } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);
  const existing = db.prepare('SELECT incident_number FROM incidents WHERE id = ?').get(req.params.id);

  db.prepare(`
    UPDATE incidents SET job_id=?, incident_type=?, severity=?, title=?, description=?, location=?, incident_date=?, incident_time=?, persons_involved=?, witnesses=?, immediate_actions=?, root_cause=?, investigation_status=?, notifiable_incident=?, updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(job_id, incident_type, severity, title, description, location || '', incident_date, incident_time || '', persons_involved || '', witnesses || '', immediate_actions || '', root_cause || '', investigation_status, notifiable_incident ? 1 : 0, req.params.id);

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
