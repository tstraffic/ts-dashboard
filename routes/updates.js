const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

router.get('/', (req, res) => {
  const db = getDb();
  const { job_id } = req.query;
  let query = `SELECT pu.*, j.job_number, j.client, u.full_name as submitted_by_name FROM project_updates pu JOIN jobs j ON pu.job_id = j.id JOIN users u ON pu.submitted_by_id = u.id WHERE 1=1`;
  const params = [];
  if (job_id) { query += ` AND pu.job_id = ?`; params.push(job_id); }
  query += ` ORDER BY pu.week_ending DESC, pu.created_at DESC LIMIT 100`;

  const updates = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold') ORDER BY job_number").all();
  res.render('updates/index', { title: 'Project Updates', updates, jobs, filters: req.query, user: req.session.user });
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold') ORDER BY job_number").all();
  res.render('updates/form', { title: 'Submit Weekly Update', update: null, jobs, user: req.session.user, prefillJobId: req.query.job_id || '', returnTo: req.query.return_to || '/projects#updates' });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    INSERT INTO project_updates (job_id, week_ending, summary, milestones, issues_risks, blockers, submitted_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id, b.week_ending, b.summary, b.milestones || '', b.issues_risks || '', b.blockers || '', req.session.user.id);

  // Update job's last_update_date
  db.prepare('UPDATE jobs SET last_update_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(b.week_ending, b.job_id);

  req.flash('success', 'Weekly update submitted.');
  res.redirect(b.return_to || '/projects#updates');
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const update = db.prepare(`
    SELECT pu.*, j.job_number, j.client, u.full_name as submitted_by_name
    FROM project_updates pu JOIN jobs j ON pu.job_id = j.id JOIN users u ON pu.submitted_by_id = u.id
    WHERE pu.id = ?
  `).get(req.params.id);
  if (!update) { req.flash('error', 'Update not found.'); return res.redirect('/updates'); }
  res.render('updates/show', { title: `Update: ${update.job_number}`, update, user: req.session.user });
});

// DELETE UPDATE
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const update = db.prepare('SELECT pu.*, j.job_number FROM project_updates pu JOIN jobs j ON pu.job_id = j.id WHERE pu.id = ?').get(req.params.id);
  if (!update) { req.flash('error', 'Update not found.'); return res.redirect('/updates'); }

  db.prepare('DELETE FROM project_updates WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'project_update', entityId: parseInt(req.params.id), entityLabel: `${update.job_number} - Week ${update.week_ending}`, ip: req.ip });
  req.flash('success', 'Project update deleted.');
  res.redirect('/updates');
});

module.exports = router;
