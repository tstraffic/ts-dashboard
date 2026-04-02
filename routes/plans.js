const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const upload = require('../middleware/upload');
const { autoLogDiary } = require('../lib/diary');

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
  if (plan_type && plan_type !== 'all') {
    query += " AND (tp.plan_type = ? OR tp.plan_types LIKE ?)";
    params.push(plan_type, `%${plan_type}%`);
  }
  query += ' ORDER BY tp.created_at DESC';

  const plans = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();

  const today = new Date().toISOString().split('T')[0];
  res.render('plans/index', { title: 'Traffic Plans', plans, jobs, filters: { status, job_id, plan_type }, user: req.session.user, today });
});

// New plan form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, site_address, suburb FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('plans/form', { title: 'New Traffic Plan', plan: null, jobs, users, user: req.session.user, preselectedJobId: req.query.job_id || null });
});

// Create plan
router.post('/', upload.single('plan_file'), (req, res) => {
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

  // Handle multi-select plan types
  let planTypes = '';
  let planType = '';
  if (b.plan_types) {
    const types = Array.isArray(b.plan_types) ? b.plan_types : [b.plan_types];
    planTypes = types.join(',');
    planType = types[0]; // backward compat
  } else if (b.plan_type) {
    planType = b.plan_type;
    planTypes = b.plan_type;
  }

  // Handle file upload
  const filePath = req.file ? req.file.path.replace(/\\/g, '/') : '';
  const fileOriginalName = req.file ? req.file.originalname : '';

  try {
    db.prepare(`
      INSERT INTO traffic_plans (job_id, plan_number, plan_type, plan_types, designer, rol_required, rol_submitted, rol_approved, council, tfnsw, submitted_date, approval_date, approved_date, expiry_date, client_required_date, works_expected_date, status, file_link, file_path, file_original_name, notes, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.job_id || null, planNumber, planType, planTypes, b.designer || '',
      b.rol_required ? 1 : 0, b.rol_submitted ? 1 : 0, b.rol_approved ? 1 : 0,
      b.council || '', b.tfnsw || '',
      b.submitted_date || null, b.approval_date || null, b.approved_date || null, b.expiry_date || null,
      b.client_required_date || null, b.works_expected_date || null,
      b.status || 'draft', b.file_link || '', filePath, fileOriginalName, b.notes || '',
      req.session.user.id
    );
    const typeMap = { TGS: 'TGS', TCP: 'TCP', TMP: 'TMP', ROL: 'ROL' };
    const typeLabel = (planTypes || planType || '').split(',').map(t => typeMap[t] || t).join(' / ');
    autoLogDiary(db, {
      jobId: b.job_id,
      summary: `Traffic plan created: ${planNumber} (${typeLabel}). Designer: ${b.designer || 'unassigned'}. Status: ${b.status || 'draft'}.`,
      userId: req.session.user.id
    });

    req.flash('success', `Traffic Plan ${planNumber} created successfully.`);
    const returnTo = b.return_to && b.return_to !== '/plans' ? b.return_to : '/plans';
    res.redirect(returnTo);
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
  const jobs = db.prepare("SELECT id, job_number, client, site_address, suburb FROM jobs WHERE status IN ('active','on_hold','won','prestart','tender') ORDER BY job_number DESC").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('plans/form', { title: 'Edit Traffic Plan', plan, jobs, users, user: req.session.user, preselectedJobId: null });
});

// Update plan
router.post('/:id', upload.single('plan_file'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const oldPlan = db.prepare('SELECT * FROM traffic_plans WHERE id = ?').get(req.params.id);

  // Handle multi-select plan types
  let planTypes = '';
  let planType = '';
  if (b.plan_types) {
    const types = Array.isArray(b.plan_types) ? b.plan_types : [b.plan_types];
    planTypes = types.join(',');
    planType = types[0];
  } else if (b.plan_type) {
    planType = b.plan_type;
    planTypes = b.plan_type;
  }

  // Handle file upload (keep existing file if no new upload)
  let filePath = b.existing_file_path || '';
  let fileOriginalName = b.existing_file_original_name || '';
  if (req.file) {
    filePath = req.file.path.replace(/\\/g, '/');
    fileOriginalName = req.file.originalname;
  }

  try {
    db.prepare(`
      UPDATE traffic_plans SET job_id=?, plan_type=?, plan_types=?, designer=?, rol_required=?, rol_submitted=?, rol_approved=?, council=?, tfnsw=?, submitted_date=?, approval_date=?, approved_date=?, expiry_date=?, client_required_date=?, works_expected_date=?, status=?, file_link=?, file_path=?, file_original_name=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.job_id || null, planType, planTypes, b.designer || '',
      b.rol_required ? 1 : 0, b.rol_submitted ? 1 : 0, b.rol_approved ? 1 : 0,
      b.council || '', b.tfnsw || '',
      b.submitted_date || null, b.approval_date || null, b.approved_date || null, b.expiry_date || null,
      b.client_required_date || null, b.works_expected_date || null,
      b.status || 'draft', b.file_link || '', filePath, fileOriginalName, b.notes || '',
      req.params.id
    );
    // Auto-log changes to site diary
    if (oldPlan) {
      const changes = [];
      if ((oldPlan.status || '') !== (b.status || '')) changes.push(`Status: ${oldPlan.status || 'draft'} → ${b.status || 'draft'}`);
      if ((oldPlan.submitted_date || '') !== (b.submitted_date || '')) changes.push(`Submitted: ${b.submitted_date || 'cleared'}`);
      if ((oldPlan.approved_date || '') !== (b.approved_date || '')) changes.push(`Approved: ${b.approved_date || 'cleared'}`);
      if ((oldPlan.designer || '') !== (b.designer || '')) changes.push(`Designer: ${b.designer || 'unassigned'}`);
      if (oldPlan.rol_required != (b.rol_required ? 1 : 0)) changes.push(b.rol_required ? 'ROL required' : 'ROL not required');
      if (oldPlan.rol_approved != (b.rol_approved ? 1 : 0)) changes.push(b.rol_approved ? 'ROL approved' : 'ROL approval removed');
      if (changes.length > 0) {
        autoLogDiary(db, {
          jobId: b.job_id || oldPlan.job_id,
          summary: `Traffic plan updated (${oldPlan.plan_number}): ${changes.join('. ')}.`,
          userId: req.session.user ? req.session.user.id : null
        });
      }
    }

    req.flash('success', 'Traffic plan updated successfully.');
    const returnTo = b.return_to && b.return_to !== '/plans' ? b.return_to : '/plans';
    res.redirect(returnTo);
  } catch (err) {
    req.flash('error', 'Failed to update plan: ' + err.message);
    res.redirect(`/plans/${req.params.id}/edit`);
  }
});

// Delete plan
router.post('/:id/delete', (req, res) => {
  try {
    const db = getDb();
    const plan = db.prepare('SELECT id, plan_number FROM traffic_plans WHERE id = ?').get(req.params.id);
    if (!plan) {
      req.flash('error', 'Plan not found.');
      return res.redirect('/plans');
    }
    const result = db.prepare('DELETE FROM traffic_plans WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      req.flash('error', 'Failed to delete plan — no rows affected.');
    } else {
      req.flash('success', `Traffic plan ${plan.plan_number} deleted.`);
    }
    res.redirect('/plans');
  } catch (err) {
    console.error('[Plans] Delete error:', err.message, err.stack);
    req.flash('error', 'Failed to delete plan: ' + err.message);
    res.redirect('/plans');
  }
});

module.exports = router;
