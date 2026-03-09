const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');

// List all jobs
router.get('/', (req, res) => {
  const db = getDb();
  const { status, search, suburb } = req.query;
  let query = `SELECT j.*, u.full_name as pm_name, bm.budget_contract, bm.total_spent as budget_spent FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id LEFT JOIN (SELECT b.job_id, b.contract_value as budget_contract, COALESCE((SELECT SUM(amount) FROM cost_entries ce WHERE ce.job_id = b.job_id), 0) as total_spent FROM job_budgets b) bm ON j.id = bm.job_id WHERE 1=1`;
  const params = [];

  if (status && status !== 'all') {
    query += ` AND j.status = ?`;
    params.push(status);
  }
  if (search) {
    query += ` AND (j.job_number LIKE ? OR j.client LIKE ? OR j.suburb LIKE ? OR j.job_name LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (suburb && suburb !== 'all') {
    query += ` AND j.suburb = ?`;
    params.push(suburb);
  }
  query += ` ORDER BY CASE j.status WHEN 'active' THEN 1 WHEN 'on_hold' THEN 2 WHEN 'won' THEN 3 WHEN 'tender' THEN 4 WHEN 'prestart' THEN 5 WHEN 'completed' THEN 6 ELSE 7 END, j.start_date DESC`;

  const jobs = db.prepare(query).all(...params);
  const suburbs = db.prepare('SELECT DISTINCT suburb FROM jobs ORDER BY suburb').all().map(r => r.suburb);

  res.render('jobs/index', { title: 'Jobs Register', jobs, suburbs, filters: { status, search, suburb }, user: req.session.user, canViewAccounts: canViewAccounts(req.session.user) });
});

// New job form
router.get('/new', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('jobs/form', { title: 'Create New Job', job: null, users, user: req.session.user });
});

// Create job
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const jobName = `${b.job_number} | ${b.client} | ${b.suburb} | ${b.start_date}`;

  try {
    db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status, division_tags, notes,
        client_project_number, project_name, principal_contractor, traffic_supervisor_id,
        contract_value, estimated_hours, crew_size, rol_required, tmp_required, sharepoint_url, state, required_tcp_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.job_number, jobName, b.client, b.site_address, b.suburb,
      b.status || 'tender', b.stage || 'tender', parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health || 'green', b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || ''
    );
    req.flash('success', `Job ${b.job_number} created successfully.`);
    res.redirect('/jobs');
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Job number ${b.job_number} already exists.`);
    } else {
      req.flash('error', 'Failed to create job: ' + err.message);
    }
    res.redirect('/jobs/new');
  }
});

// Job detail page
router.get('/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT j.*,
      pm.full_name as pm_name, ops.full_name as ops_name,
      pl.full_name as planning_name, mk.full_name as marketing_name,
      ac.full_name as accounts_name, ts.full_name as traffic_supervisor_name
    FROM jobs j
    LEFT JOIN users pm ON j.project_manager_id = pm.id
    LEFT JOIN users ops ON j.ops_supervisor_id = ops.id
    LEFT JOIN users pl ON j.planning_owner_id = pl.id
    LEFT JOIN users mk ON j.marketing_owner_id = mk.id
    LEFT JOIN users ac ON j.accounts_owner_id = ac.id
    LEFT JOIN users ts ON j.traffic_supervisor_id = ts.id
    WHERE j.id = ?
  `).get(req.params.id);

  if (!job) {
    req.flash('error', 'Job not found.');
    return res.redirect('/jobs');
  }

  const tasks = db.prepare(`
    SELECT t.*, u.full_name as owner_name FROM tasks t
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE t.job_id = ? ORDER BY CASE t.status WHEN 'blocked' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'not_started' THEN 3 ELSE 4 END, t.due_date ASC
  `).all(job.id);

  const updates = db.prepare(`
    SELECT pu.*, u.full_name as submitted_by_name FROM project_updates pu
    LEFT JOIN users u ON pu.submitted_by_id = u.id
    WHERE pu.job_id = ? ORDER BY pu.week_ending DESC
  `).all(job.id);

  const complianceItems = db.prepare(`
    SELECT c.*, u.full_name as approver_name FROM compliance c
    LEFT JOIN users u ON c.internal_approver_id = u.id
    WHERE c.job_id = ? ORDER BY c.due_date ASC
  `).all(job.id);

  const deliveryDocs = db.prepare("SELECT * FROM documents WHERE job_id = ? AND library = 'delivery' ORDER BY category, original_name").all(job.id);
  const accountsDocs = canViewAccounts(req.session.user)
    ? db.prepare("SELECT * FROM documents WHERE job_id = ? AND library = 'accounts' ORDER BY category, original_name").all(job.id)
    : [];

  // Incidents for this job
  const incidents = db.prepare(`
    SELECT i.*, u.full_name as reported_by_name FROM incidents i
    LEFT JOIN users u ON i.reported_by_id = u.id
    WHERE i.job_id = ? ORDER BY i.incident_date DESC
  `).all(job.id);

  // Contacts for this job
  const contacts = db.prepare(`
    SELECT * FROM client_contacts WHERE job_id = ? ORDER BY is_primary DESC, full_name ASC
  `).all(job.id);

  // Timesheets for this job (recent)
  const timesheets = db.prepare(`
    SELECT ts.*, cm.full_name as crew_name, u.full_name as approved_by_name
    FROM timesheets ts
    LEFT JOIN crew_members cm ON ts.crew_member_id = cm.id
    LEFT JOIN users u ON ts.approved_by_id = u.id
    WHERE ts.job_id = ? ORDER BY ts.work_date DESC LIMIT 50
  `).all(job.id);

  // Budget for this job
  const budget = db.prepare(`SELECT * FROM job_budgets WHERE job_id = ?`).get(job.id);
  const costEntries = db.prepare(`
    SELECT ce.*, u.full_name as entered_by_name FROM cost_entries ce
    LEFT JOIN users u ON ce.entered_by_id = u.id
    WHERE ce.job_id = ? ORDER BY ce.entry_date DESC LIMIT 30
  `).all(job.id);
  const totalSpend = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries WHERE job_id = ?`).get(job.id).total;

  // Equipment assigned to this job
  const equipmentAssignments = db.prepare(`
    SELECT ea.*, e.name as equipment_name, e.asset_number, e.category, e.current_condition as equipment_condition,
      u.full_name as assigned_by_name
    FROM equipment_assignments ea
    LEFT JOIN equipment e ON ea.equipment_id = e.id
    LEFT JOIN users u ON ea.assigned_by_id = u.id
    WHERE ea.job_id = ? ORDER BY ea.assigned_date DESC
  `).all(job.id);

  // Defects for this job
  const defects = db.prepare(`
    SELECT d.*, u.full_name as reported_by_name, u2.full_name as assigned_to_name
    FROM defects d
    LEFT JOIN users u ON d.reported_by_id = u.id
    LEFT JOIN users u2 ON d.assigned_to_id = u2.id
    WHERE d.job_id = ? ORDER BY CASE d.severity WHEN 'critical' THEN 1 WHEN 'major' THEN 2 WHEN 'moderate' THEN 3 ELSE 4 END, d.created_at DESC
  `).all(job.id);

  // Traffic plans for this job
  const trafficPlans = db.prepare(`
    SELECT tp.*, u.full_name as created_by_name FROM traffic_plans tp
    LEFT JOIN users u ON tp.created_by_id = u.id
    WHERE tp.job_id = ? ORDER BY tp.created_at DESC
  `).all(job.id);

  res.render('jobs/show', {
    title: job.job_number,
    job, tasks, updates, complianceItems, deliveryDocs, accountsDocs,
    incidents, contacts, timesheets, budget, costEntries, totalSpend,
    equipmentAssignments, defects, trafficPlans,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Edit job form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Job not found.'); return res.redirect('/jobs'); }
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('jobs/form', { title: 'Edit Job', job, users, user: req.session.user });
});

// Update job
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const jobName = `${b.job_number} | ${b.client} | ${b.suburb} | ${b.start_date}`;

  try {
    db.prepare(`
      UPDATE jobs SET job_number=?, job_name=?, client=?, site_address=?, suburb=?, status=?, stage=?, percent_complete=?, start_date=?, end_date=?,
        project_manager_id=?, ops_supervisor_id=?, planning_owner_id=?, marketing_owner_id=?, accounts_owner_id=?,
        health=?, accounts_status=?, division_tags=?, notes=?,
        client_project_number=?, project_name=?, principal_contractor=?, traffic_supervisor_id=?,
        contract_value=?, estimated_hours=?, crew_size=?, rol_required=?, tmp_required=?, sharepoint_url=?, state=?,
        required_tcp_level=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.job_number, jobName, b.client, b.site_address, b.suburb,
      b.status, b.stage, parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health, b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      req.params.id
    );
    req.flash('success', 'Job updated successfully.');
    res.redirect(`/jobs/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Failed to update job: ' + err.message);
    res.redirect(`/jobs/${req.params.id}/edit`);
  }
});

// Delete job
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  req.flash('success', 'Job deleted.');
  res.redirect('/jobs');
});

module.exports = router;
