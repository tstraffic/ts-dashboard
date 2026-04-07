const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const upload = require('../middleware/upload');
const { autoLogDiary, logStatusChange } = require('../lib/diary');

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

  // Auto-generate document code: TSTGS-XXXX-XX or TSTMP-XXXX-XX
  // Extract job sequence number from job code (TSJ-XXXX → XXXX)
  let jobSeq = '0000';
  if (b.job_id) {
    const parentJob = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (parentJob && parentJob.job_number) {
      const seqMatch = parentJob.job_number.match(/TSJ-(\d+)/);
      if (seqMatch) jobSeq = seqMatch[1];
      else jobSeq = parentJob.job_number.replace(/[^0-9]/g, '').padStart(4, '0').slice(-4);
    }
  }

  // Determine plan type prefix
  const primaryType = (Array.isArray(b.plan_types) ? b.plan_types[0] : b.plan_types || b.plan_type || 'TGS').toUpperCase();
  const codePrefix = primaryType === 'TMP' ? 'TSTMP' : 'TSTGS';

  // Count existing plans of this type for this job to get next suffix
  const existingCount = b.job_id
    ? db.prepare(`SELECT COUNT(*) as cnt FROM traffic_plans WHERE job_id = ? AND plan_number LIKE ?`).get(b.job_id, `${codePrefix}-${jobSeq}-%`).cnt
    : 0;
  const planSuffix = String(existingCount + 1).padStart(2, '0');
  const planNumber = `${codePrefix}-${jobSeq}-${planSuffix}`;

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
      summary: `[${req.session.user.full_name}] Traffic plan created: ${planNumber} (${typeLabel}). Designer: ${b.designer || 'unassigned'}. Status: ${b.status || 'draft'}.`,
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
          summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Traffic plan updated (${oldPlan.plan_number}): ${changes.join('. ')}.`,
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

// ─── MARK AS FINAL ───────────────────────────────
router.post('/:id/mark-final', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT tp.*, j.job_number FROM traffic_plans tp LEFT JOIN jobs j ON tp.job_id = j.id WHERE tp.id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect('/plans'); }

  try {
    db.prepare('UPDATE traffic_plans SET is_final = 1, marked_final_at = CURRENT_TIMESTAMP, marked_final_by = ?, status = ? WHERE id = ?')
      .run(req.session.user.id, 'approved', plan.id);

    logStatusChange(db, {
      jobId: plan.job_id, entityType: 'plan',
      entityLabel: `Plan ${plan.plan_number}`,
      oldStatus: plan.status || 'draft', newStatus: 'final',
      userId: req.session.user.id, userName: req.session.user.full_name
    });

    req.flash('success', `Plan ${plan.plan_number} marked as final and published to operations.`);
  } catch (err) {
    req.flash('error', 'Failed to mark plan as final: ' + err.message);
  }
  res.redirect(req.body.return_to || `/plans/${plan.id}`);
});

// ─── REVOKE FINAL ────────────────────────────────
router.post('/:id/revoke-final', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT tp.*, j.job_number FROM traffic_plans tp LEFT JOIN jobs j ON tp.job_id = j.id WHERE tp.id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect('/plans'); }

  try {
    db.prepare('UPDATE traffic_plans SET is_final = 0, status = ? WHERE id = ?')
      .run('draft', plan.id);

    logStatusChange(db, {
      jobId: plan.job_id, entityType: 'plan',
      entityLabel: `Plan ${plan.plan_number}`,
      oldStatus: 'final', newStatus: 'draft',
      userId: req.session.user.id, userName: req.session.user.full_name
    });

    req.flash('success', `Plan ${plan.plan_number} revoked — no longer visible to operations.`);
  } catch (err) {
    req.flash('error', 'Failed to revoke plan: ' + err.message);
  }
  res.redirect(req.body.return_to || `/plans/${plan.id}`);
});

// ─── ADD REVISION ────────────────────────────────
router.post('/:id/revisions', upload.single('revision_file'), (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM traffic_plans WHERE id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect('/plans'); }

  const b = req.body;
  const filePath = req.file ? req.file.path.replace(/\\/g, '/') : '';
  const fileOriginalName = req.file ? req.file.originalname : '';

  // Auto-increment revision label (Rev A → Rev B → Rev C...)
  const lastRevision = db.prepare('SELECT revision_label FROM plan_revisions WHERE plan_id = ? ORDER BY id DESC LIMIT 1').get(plan.id);
  let nextLabel = 'Rev A';
  if (lastRevision) {
    const letter = lastRevision.revision_label.replace('Rev ', '');
    nextLabel = 'Rev ' + String.fromCharCode(letter.charCodeAt(0) + 1);
  } else if (plan.current_revision_label) {
    const letter = plan.current_revision_label.replace('Rev ', '');
    nextLabel = 'Rev ' + String.fromCharCode(letter.charCodeAt(0) + 1);
  }

  try {
    db.prepare('INSERT INTO plan_revisions (plan_id, revision_label, file_url, file_path, file_original_name, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(plan.id, nextLabel, b.file_url || '', filePath, fileOriginalName, b.notes || '', req.session.user.id);

    db.prepare('UPDATE traffic_plans SET current_revision_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(nextLabel, plan.id);

    autoLogDiary(db, {
      jobId: plan.job_id,
      summary: `[${req.session.user.full_name}] Plan ${plan.plan_number} revised to ${nextLabel}. ${b.notes || ''}`,
      userId: req.session.user.id
    });

    req.flash('success', `Revision ${nextLabel} added to plan ${plan.plan_number}.`);
  } catch (err) {
    req.flash('error', 'Failed to add revision: ' + err.message);
  }
  res.redirect(req.body.return_to || `/plans/${plan.id}`);
});

// ─── FLAG FOR REVIEW (Operations → Planning) ────
router.post('/:id/flag', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT tp.*, j.job_number, j.id as jid FROM traffic_plans tp LEFT JOIN jobs j ON tp.job_id = j.id WHERE tp.id = ?').get(req.params.id);
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect('/plans'); }

  const description = req.body.description;
  if (!description || !description.trim()) {
    req.flash('error', 'Please describe the issue.');
    return res.redirect(req.body.return_to || `/jobs/${plan.jid}#final-plans`);
  }

  try {
    // Create flag record
    db.prepare('INSERT INTO plan_flags (plan_id, job_id, flagged_by, description) VALUES (?, ?, ?, ?)')
      .run(plan.id, plan.jid, req.session.user.id, description.trim());

    // Create a task on the planning side tagged to this document
    db.prepare(`INSERT INTO tasks (job_id, title, description, status, priority, division, created_at)
      VALUES (?, ?, ?, 'not_started', 'high', 'planning', CURRENT_TIMESTAMP)`)
      .run(plan.jid,
        `⚠️ Site issue flagged on ${plan.plan_number}`,
        `Flagged by ${req.session.user.full_name}: "${description.trim()}"`
      );

    req.flash('success', `Issue flagged on ${plan.plan_number}. Planning team has been notified.`);
  } catch (err) {
    req.flash('error', 'Failed to flag issue: ' + err.message);
  }
  res.redirect(req.body.return_to || `/jobs/${plan.jid}#final-plans`);
});

module.exports = router;
