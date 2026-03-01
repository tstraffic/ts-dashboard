const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id, item_type } = req.query;
  let query = `SELECT c.*, j.job_number, j.client, u.full_name as approver_name FROM compliance c JOIN jobs j ON c.job_id = j.id LEFT JOIN users u ON c.internal_approver_id = u.id WHERE 1=1`;
  const params = [];

  if (status && status !== 'all') { query += ` AND c.status = ?`; params.push(status); }
  if (job_id) { query += ` AND c.job_id = ?`; params.push(job_id); }
  if (item_type && item_type !== 'all') { query += ` AND c.item_type = ?`; params.push(item_type); }
  query += ` ORDER BY CASE c.status WHEN 'not_started' THEN 1 WHEN 'submitted' THEN 2 WHEN 'rejected' THEN 3 WHEN 'expired' THEN 4 ELSE 5 END, c.due_date ASC`;

  const items = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  res.render('compliance/index', { title: 'Compliance & Approvals', items, jobs, filters: req.query, user: req.session.user });
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('compliance/form', { title: 'New Compliance Item', item: null, jobs, users, user: req.session.user, prefillJobId: req.query.job_id || '' });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    INSERT INTO compliance (job_id, item_type, title, authority_approver, internal_approver_id, due_date, submitted_date, approved_date, expiry_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id, b.item_type, b.title, b.authority_approver || '', b.internal_approver_id || null, b.due_date, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status || 'not_started', b.notes || '');
  req.flash('success', 'Compliance item created.');
  res.redirect(b.return_to || '/compliance');
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('compliance/form', { title: 'Edit Compliance Item', item, jobs, users, user: req.session.user, prefillJobId: '' });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    UPDATE compliance SET job_id=?, item_type=?, title=?, authority_approver=?, internal_approver_id=?, due_date=?, submitted_date=?, approved_date=?, expiry_date=?, status=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(b.job_id, b.item_type, b.title, b.authority_approver || '', b.internal_approver_id || null, b.due_date, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status, b.notes || '', req.params.id);
  req.flash('success', 'Compliance item updated.');
  res.redirect(b.return_to || '/compliance');
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM compliance WHERE id = ?').run(req.params.id);
  req.flash('success', 'Compliance item deleted.');
  res.redirect(req.body.return_to || '/compliance');
});

module.exports = router;
