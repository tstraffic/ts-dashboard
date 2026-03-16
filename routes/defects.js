const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// Generate next defect number
function nextDefectNumber(db) {
  const last = db.prepare("SELECT defect_number FROM defects ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'DEF-00001';
  const num = parseInt(last.defect_number.replace('DEF-', '')) + 1;
  return 'DEF-' + String(num).padStart(5, '0');
}

// LIST
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('d.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.severity) { where.push('d.severity = ?'); params.push(req.query.severity); }
  if (req.query.status) { where.push('d.status = ?'); params.push(req.query.status); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const defects = db.prepare(`
    SELECT d.*, j.job_number, j.client, u.full_name as reported_by_name, a.full_name as assigned_to_name
    FROM defects d
    JOIN jobs j ON d.job_id = j.id
    JOIN users u ON d.reported_by_id = u.id
    LEFT JOIN users a ON d.assigned_to_id = a.id
    ${whereClause}
    ORDER BY CASE d.severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END, d.reported_date DESC
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  // Compute stats
  const allDefects = db.prepare('SELECT severity, status, target_close_date FROM defects').all();
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    total: allDefects.length,
    open: allDefects.filter(d => !['closed', 'deferred'].includes(d.status)).length,
    criticalMajor: allDefects.filter(d => ['critical', 'major'].includes(d.severity) && !['closed', 'deferred'].includes(d.status)).length,
    overdue: allDefects.filter(d => d.target_close_date && d.target_close_date < today && !['closed', 'deferred'].includes(d.status)).length
  };

  res.render('defects/index', {
    title: 'Defects',
    currentPage: 'defects',
    defects,
    jobs,
    filters: req.query,
    stats
  });
});

// Inline status change
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const valid = ['open', 'investigating', 'rectification', 'closed', 'deferred'];
  if (!valid.includes(status)) { req.flash('error', 'Invalid status'); return res.redirect('/defects'); }
  db.prepare('UPDATE defects SET status = ? WHERE id = ?').run(status, req.params.id);
  res.redirect('/defects');
});

// NEW FORM
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('defects/form', {
    title: 'Report Defect',
    currentPage: 'defects',
    defect: null,
    jobs,
    users,
    preselectedJobId: req.query.job_id || ''
  });
});

// CREATE
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, title, description, location, severity, assigned_to_id, reported_date, target_close_date } = req.body;
  const defect_number = nextDefectNumber(db);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  const result = db.prepare(`
    INSERT INTO defects (job_id, defect_number, title, description, location, severity, reported_by_id, assigned_to_id, reported_date, target_close_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job_id, defect_number, title, description, location || '', severity || 'minor', req.session.user.id, assigned_to_id || null, reported_date, target_close_date || null);

  logActivity({ user: req.session.user, action: 'create', entityType: 'defect', entityId: result.lastInsertRowid, entityLabel: `${defect_number} - ${title}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', `Defect ${defect_number} reported.`);
  res.redirect(`/defects/${result.lastInsertRowid}`);
});

// SHOW
router.get('/:id', (req, res) => {
  const db = getDb();
  const defect = db.prepare(`
    SELECT d.*, j.job_number, j.client, u.full_name as reported_by_name, a.full_name as assigned_to_name
    FROM defects d
    JOIN jobs j ON d.job_id = j.id
    JOIN users u ON d.reported_by_id = u.id
    LEFT JOIN users a ON d.assigned_to_id = a.id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!defect) { req.flash('error', 'Defect not found.'); return res.redirect('/defects'); }

  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  res.render('defects/show', {
    title: `Defect ${defect.defect_number}`,
    currentPage: 'defects',
    defect,
    users
  });
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const defect = db.prepare('SELECT * FROM defects WHERE id = ?').get(req.params.id);
  if (!defect) { req.flash('error', 'Defect not found.'); return res.redirect('/defects'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('defects/form', {
    title: `Edit ${defect.defect_number}`,
    currentPage: 'defects',
    defect,
    jobs,
    users,
    preselectedJobId: ''
  });
});

// UPDATE
router.post('/:id', (req, res) => {
  const db = getDb();
  const { job_id, title, description, location, severity, status, assigned_to_id, reported_date, target_close_date, rectification_notes } = req.body;
  const existing = db.prepare('SELECT defect_number FROM defects WHERE id = ?').get(req.params.id);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  // Auto-set close date if status changed to closed
  let actual_close_date = null;
  if (status === 'closed') {
    actual_close_date = new Date().toISOString().split('T')[0];
  }

  db.prepare(`
    UPDATE defects SET job_id=?, title=?, description=?, location=?, severity=?, status=?, assigned_to_id=?, reported_date=?, target_close_date=?, actual_close_date=COALESCE(?, actual_close_date), rectification_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(job_id, title, description, location || '', severity, status, assigned_to_id || null, reported_date, target_close_date || null, actual_close_date, rectification_notes || '', req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'defect', entityId: parseInt(req.params.id), entityLabel: existing ? existing.defect_number : title, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', 'Defect updated.');
  res.redirect(`/defects/${req.params.id}`);
});

// DELETE
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const defect = db.prepare('SELECT defect_number, job_id FROM defects WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM defects WHERE id = ?').run(req.params.id);
  if (defect) {
    logActivity({ user: req.session.user, action: 'delete', entityType: 'defect', entityId: parseInt(req.params.id), entityLabel: defect.defect_number, jobId: defect.job_id, ip: req.ip });
  }
  req.flash('success', 'Defect deleted.');
  res.redirect('/defects');
});

// QUICK STATUS UPDATE (from show page inline form)
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status, rectification_notes } = req.body;
  const existing = db.prepare('SELECT defect_number, job_id FROM defects WHERE id = ?').get(req.params.id);

  let actual_close_date = null;
  if (status === 'closed') {
    actual_close_date = new Date().toISOString().split('T')[0];
  }

  db.prepare(`
    UPDATE defects SET status=?, rectification_notes=?, actual_close_date=COALESCE(?, actual_close_date), updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(status, rectification_notes || '', actual_close_date, req.params.id);

  if (existing) {
    logActivity({ user: req.session.user, action: 'update', entityType: 'defect', entityId: parseInt(req.params.id), entityLabel: `${existing.defect_number} status -> ${status}`, jobId: existing.job_id, ip: req.ip });
  }
  req.flash('success', `Status updated to ${status}.`);
  res.redirect(`/defects/${req.params.id}`);
});

module.exports = router;
