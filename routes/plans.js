const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// List all traffic plans
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id, plan_type } = req.query;
  let query = `SELECT tp.*, j.job_number, j.client, u.full_name as created_by_name
    FROM traffic_plans tp
    LEFT JOIN jobs j ON tp.job_id = j.id
    LEFT JOIN users u ON tp.created_by_id = u.id WHERE 1=1`;
  const params = [];

  if (status && status !== 'all') { query += ' AND tp.status = ?'; params.push(status); }
  if (job_id) { query += ' AND tp.job_id = ?'; params.push(job_id); }
  if (plan_type && plan_type !== 'all') { query += ' AND tp.plan_type = ?'; params.push(plan_type); }
  query += ' ORDER BY tp.created_at DESC';

  const plans = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();

  res.render('plans/index', { title: 'Traffic Plans', plans, jobs, filters: { status, job_id, plan_type }, user: req.session.user });
});

// New plan form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('plans/form', { title: 'New Traffic Plan', plan: null, jobs, users, user: req.session.user, preselectedJobId: req.query.job_id || null });
});

// Create plan
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  // Auto-generate plan number
  const lastPlan = db.prepare("SELECT plan_number FROM traffic_plans ORDER BY id DESC LIMIT 1").get();
  let nextNum = 1;
  if (lastPlan && lastPlan.plan_number) {
    const match = lastPlan.plan_number.match(/TP-(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }
  const planNumber = 'TP-' + String(nextNum).padStart(5, '0');

  try {
    db.prepare(`
      INSERT INTO traffic_plans (job_id, plan_number, plan_type, designer, rol_required, rol_submitted, rol_approved, council, tfnsw, submitted_date, approval_date, approved_date, expiry_date, status, file_link, notes, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.job_id, planNumber, b.plan_type, b.designer || '',
      b.rol_required ? 1 : 0, b.rol_submitted ? 1 : 0, b.rol_approved ? 1 : 0,
      b.council || '', b.tfnsw || '',
      b.submitted_date || null, b.approval_date || null, b.approved_date || null, b.expiry_date || null,
      b.status || 'draft', b.file_link || '', b.notes || '',
      req.session.user.id
    );
    req.flash('success', `Traffic Plan ${planNumber} created successfully.`);
    res.redirect('/plans');
  } catch (err) {
    req.flash('error', 'Failed to create plan: ' + err.message);
    res.redirect('/plans/new');
  }
});

// Edit plan form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM traffic_plans WHERE id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect('/plans'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('plans/form', { title: 'Edit Traffic Plan', plan, jobs, users, user: req.session.user, preselectedJobId: null });
});

// Update plan
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    db.prepare(`
      UPDATE traffic_plans SET job_id=?, plan_type=?, designer=?, rol_required=?, rol_submitted=?, rol_approved=?, council=?, tfnsw=?, submitted_date=?, approval_date=?, approved_date=?, expiry_date=?, status=?, file_link=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.job_id, b.plan_type, b.designer || '',
      b.rol_required ? 1 : 0, b.rol_submitted ? 1 : 0, b.rol_approved ? 1 : 0,
      b.council || '', b.tfnsw || '',
      b.submitted_date || null, b.approval_date || null, b.approved_date || null, b.expiry_date || null,
      b.status || 'draft', b.file_link || '', b.notes || '',
      req.params.id
    );
    req.flash('success', 'Traffic plan updated successfully.');
    res.redirect('/plans');
  } catch (err) {
    req.flash('error', 'Failed to update plan: ' + err.message);
    res.redirect(`/plans/${req.params.id}/edit`);
  }
});

// Delete plan
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM traffic_plans WHERE id = ?').run(req.params.id);
  req.flash('success', 'Traffic plan deleted.');
  res.redirect('/plans');
});

module.exports = router;
