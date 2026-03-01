const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id, division, owner, priority } = req.query;
  let query = `SELECT t.*, j.job_number, j.client, u.full_name as owner_name FROM tasks t JOIN jobs j ON t.job_id = j.id LEFT JOIN users u ON t.owner_id = u.id WHERE 1=1`;
  const params = [];

  if (status && status !== 'all') { query += ` AND t.status = ?`; params.push(status); }
  if (job_id) { query += ` AND t.job_id = ?`; params.push(job_id); }
  if (division && division !== 'all') { query += ` AND t.division = ?`; params.push(division); }
  if (owner === 'me') { query += ` AND t.owner_id = ?`; params.push(req.session.user.id); }
  if (priority && priority !== 'all') { query += ` AND t.priority = ?`; params.push(priority); }

  query += ` ORDER BY CASE t.status WHEN 'blocked' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'not_started' THEN 3 ELSE 4 END, t.due_date ASC`;
  const tasks = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('tasks/index', { title: 'Tasks & Actions', tasks, jobs, filters: req.query, user: req.session.user });
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('tasks/form', { title: 'New Task', task: null, jobs, users, user: req.session.user, prefillJobId: req.query.job_id || '' });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id, b.division, b.title, b.description || '', b.owner_id, b.due_date, b.status || 'not_started', b.priority || 'medium', b.notes || '');
  req.flash('success', 'Task created.');
  res.redirect(b.return_to || '/tasks');
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) { req.flash('error', 'Task not found.'); return res.redirect('/tasks'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('tasks/form', { title: 'Edit Task', task, jobs, users, user: req.session.user, prefillJobId: '' });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const completedDate = b.status === 'complete' ? new Date().toISOString().split('T')[0] : null;
  db.prepare(`
    UPDATE tasks SET job_id=?, division=?, title=?, description=?, owner_id=?, due_date=?, status=?, priority=?, notes=?, completed_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(b.job_id, b.division, b.title, b.description || '', b.owner_id, b.due_date, b.status, b.priority, b.notes || '', completedDate, req.params.id);
  req.flash('success', 'Task updated.');
  res.redirect(b.return_to || '/tasks');
});

router.post('/:id/complete', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare("UPDATE tasks SET status = 'complete', completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(today, req.params.id);
  req.flash('success', 'Task completed.');
  res.redirect(req.body.return_to || '/tasks');
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  req.flash('success', 'Task deleted.');
  res.redirect(req.body.return_to || '/tasks');
});

module.exports = router;
