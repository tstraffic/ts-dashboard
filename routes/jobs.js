const express = require('express');
const router = express.Router();
const pathLib = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const { ensureThreadForEntity, addMembersToThread, postSystemMessage, getThreadForEntity } = require('../lib/chat');

// Multer for diary attachments
const diaryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = pathLib.join(__dirname, '..', 'data', 'uploads', 'diary', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + pathLib.extname(file.originalname));
  }
});
const diaryUpload = multer({ storage: diaryStorage, limits: { fileSize: 25 * 1024 * 1024 } });

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

  // Compute stats from the full (unfiltered) job set for the stat cards
  const allJobs = db.prepare('SELECT status, health, end_date FROM jobs').all();
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    active: allJobs.filter(j => j.status === 'active').length,
    onHold: allJobs.filter(j => j.status === 'on_hold').length,
    tender: allJobs.filter(j => ['tender', 'won', 'prestart'].includes(j.status)).length,
    overdue: allJobs.filter(j => j.end_date && j.end_date < today && !['completed', 'closed'].includes(j.status)).length,
    healthRed: allJobs.filter(j => j.health === 'red' && !['completed', 'closed'].includes(j.status)).length
  };

  res.render('jobs/index', { title: 'Jobs Register', jobs, suburbs, filters: { status, search, suburb }, user: req.session.user, canViewAccounts: canViewAccounts(req.session.user), stats });
});

// Inline status change
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const validStatuses = ['tender', 'won', 'prestart', 'active', 'on_hold', 'completed', 'closed'];
  if (!validStatuses.includes(status)) {
    req.flash('error', 'Invalid status');
    return res.redirect('/jobs');
  }
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, req.params.id);
  res.redirect('/jobs');
});

// New job form
router.get('/new', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('jobs/form', { title: 'Create New Job', job: null, users, clients, user: req.session.user });
});

// Create job
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  console.log('[Jobs] POST / — creating job:', b.job_number, 'client_id:', b.client_id, 'suburb:', b.suburb);
  // Resolve client name from client_id
  let clientName = b.client || '';
  if (b.client_id) {
    const cl = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (cl) clientName = cl.company_name;
  }
  const jobName = `${b.job_number} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  try {
    db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, client_id, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status, division_tags, notes,
        client_project_number, project_name, principal_contractor, traffic_supervisor_id,
        contract_value, estimated_hours, crew_size, vehicles, rol_required, tmp_required, tgs_required, spa_required, council_approval, bus_approval, sharepoint_url, state, required_tcp_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.job_number, jobName, clientName, b.client_id || null, b.site_address, b.suburb,
      b.status || 'tender', b.stage || 'tender', parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health || 'green', b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0, parseInt(b.vehicles) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.tgs_required ? 1 : 0, b.spa_required ? 1 : 0, b.council_approval ? 1 : 0, b.bus_approval ? 1 : 0,
      b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || ''
    );
    // Auto-create budget record for this job
    const newJobId = db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(b.job_number);
    if (newJobId) {
      try {
        db.prepare('INSERT OR IGNORE INTO job_budgets (job_id, contract_value, updated_by_id) VALUES (?, ?, ?)').run(newJobId.id, parseFloat(b.contract_value) || 0, req.session.user.id);
      } catch(e) { /* budget may already exist */ }

      // Auto-create chat thread for this job
      const threadId = ensureThreadForEntity('job', newJobId.id, `Job ${b.job_number}`, req.session.user.id);
      const memberIds = [...new Set([req.session.user.id,
        b.project_manager_id ? parseInt(b.project_manager_id) : null,
        b.ops_supervisor_id ? parseInt(b.ops_supervisor_id) : null,
        b.planning_owner_id ? parseInt(b.planning_owner_id) : null,
        b.marketing_owner_id ? parseInt(b.marketing_owner_id) : null,
        b.accounts_owner_id ? parseInt(b.accounts_owner_id) : null
      ].filter(Boolean))];
      addMembersToThread(threadId, memberIds, 'member', true);
      postSystemMessage(threadId, `Thread created for job ${b.job_number}`);
    }

    req.flash('success', `Job ${b.job_number} created successfully.`);
    res.redirect('/jobs');
  } catch (err) {
    console.error('[Jobs] CREATE ERROR:', err.message);
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Job number ${b.job_number} already exists.`);
    } else {
      req.flash('error', 'Failed to create job: ' + err.message);
    }
    // Redirect to jobs list so flash is visible
    res.redirect('/jobs');
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

  // Compliance costs for this job (council fees + plan costs)
  const complianceCosts = db.prepare(`SELECT COALESCE(SUM(costs), 0) + COALESCE(SUM(council_fee_amount), 0) as total FROM compliance WHERE job_id = ?`).get(job.id).total;

  // Equipment maintenance costs for equipment assigned to this job
  const equipmentCosts = db.prepare(`
    SELECT COALESCE(SUM(em.cost), 0) as total FROM equipment_maintenance em
    INNER JOIN equipment_assignments ea ON em.equipment_id = ea.equipment_id
    WHERE ea.job_id = ?
  `).get(job.id).total;

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

  // Site diary entries for this job
  const diaryEntries = db.prepare(`
    SELECT sd.*, u.full_name as created_by_name,
      tp.plan_number as tgs_plan_number,
      rep.full_name as representative_name,
      comp.title as compliance_item_title,
      eq.name as linked_equipment_name, eq.asset_number as linked_asset_number
    FROM site_diary_entries sd
    LEFT JOIN users u ON sd.created_by_id = u.id
    LEFT JOIN traffic_plans tp ON sd.tgs_plan_id = tp.id
    LEFT JOIN users rep ON sd.representative_id = rep.id
    LEFT JOIN compliance comp ON sd.compliance_item_id = comp.id
    LEFT JOIN equipment_assignments eqa ON sd.equipment_assignment_id = eqa.id
    LEFT JOIN equipment eq ON eqa.equipment_id = eq.id
    WHERE sd.job_id = ? ORDER BY sd.entry_date DESC
  `).all(job.id);

  // TGS plans for the diary TGS Link dropdown
  const tgsPlans = db.prepare(`SELECT id, plan_number FROM traffic_plans WHERE job_id = ? ORDER BY plan_number`).all(job.id);

  // Compliance TGS items for diary linking
  const complianceTgsItems = db.prepare(`SELECT id, title, item_type, item_types FROM compliance WHERE job_id = ? AND (item_type = 'traffic_guidance' OR item_types LIKE '%traffic_guidance%') ORDER BY title`).all(job.id);

  // Users list for representative dropdown
  const allUsers = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  // Diary attachments (bulk fetch for all entries)
  let diaryAttachments = [];
  try { diaryAttachments = db.prepare('SELECT * FROM site_diary_attachments WHERE diary_entry_id IN (SELECT id FROM site_diary_entries WHERE job_id = ?)').all(job.id); } catch(e) { /* table may not exist yet */ }

  // Lazy-create chat thread for pre-existing jobs
  let chatThreadId = getThreadForEntity('job', job.id);
  if (!chatThreadId) {
    chatThreadId = ensureThreadForEntity('job', job.id, `Job ${job.job_number}`, req.session.user.id);
    const memberIds = [...new Set([req.session.user.id,
      job.project_manager_id, job.ops_supervisor_id,
      job.planning_owner_id, job.marketing_owner_id, job.accounts_owner_id
    ].filter(Boolean))];
    addMembersToThread(chatThreadId, memberIds, 'member', true);
    postSystemMessage(chatThreadId, `Thread created for job ${job.job_number}`);
  }

  // Chat members
  let chatMembers = [];
  try { chatMembers = db.prepare('SELECT u.id, u.full_name, u.role FROM chat_thread_members ctm JOIN users u ON ctm.user_id = u.id WHERE ctm.thread_id = ? AND u.active = 1 ORDER BY u.full_name').all(chatThreadId); } catch(e) {}

  res.render('jobs/show', {
    title: job.job_number,
    job, tasks, updates, complianceItems, deliveryDocs, accountsDocs,
    incidents, contacts, timesheets, budget, costEntries, totalSpend,
    complianceCosts, equipmentCosts,
    equipmentAssignments, defects, trafficPlans, chatThreadId, diaryEntries, tgsPlans,
    complianceTgsItems, allUsers, diaryAttachments, chatMembers,
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
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('jobs/form', { title: 'Edit Job', job, users, clients, user: req.session.user });
});

// Update job
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  let clientName = b.client || '';
  if (b.client_id) {
    const cl = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (cl) clientName = cl.company_name;
  }
  const jobName = `${b.job_number} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  try {
    db.prepare(`
      UPDATE jobs SET job_number=?, job_name=?, client=?, client_id=?, site_address=?, suburb=?, status=?, stage=?, percent_complete=?, start_date=?, end_date=?,
        project_manager_id=?, ops_supervisor_id=?, planning_owner_id=?, marketing_owner_id=?, accounts_owner_id=?,
        health=?, accounts_status=?, division_tags=?, notes=?,
        client_project_number=?, project_name=?, principal_contractor=?, traffic_supervisor_id=?,
        contract_value=?, estimated_hours=?, crew_size=?, vehicles=?, rol_required=?, tmp_required=?, tgs_required=?, spa_required=?, council_approval=?, bus_approval=?,
        sharepoint_url=?, state=?,
        required_tcp_level=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.job_number, jobName, clientName, b.client_id || null, b.site_address, b.suburb,
      b.status, b.stage, parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health, b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0, parseInt(b.vehicles) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.tgs_required ? 1 : 0, b.spa_required ? 1 : 0, b.council_approval ? 1 : 0, b.bus_approval ? 1 : 0,
      b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      req.params.id
    );
    // Archive chat thread when job is completed/closed
    if (['completed', 'closed'].includes(b.status)) {
      const threadId = getThreadForEntity('job', parseInt(req.params.id));
      if (threadId) {
        db.prepare("UPDATE chat_threads SET status = 'archived' WHERE id = ?").run(threadId);
        postSystemMessage(threadId, `Thread archived — job ${b.status}`);
      }
    }

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

// =============================================
// Site Diary CRUD
// =============================================

// Create diary entry
router.post('/:id/diary', diaryUpload.array('attachments', 5), (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO site_diary_entries (job_id, entry_date, task, representative, representative_id, client_representative, outcomes, issues, comments, stage, tgs_number, tgs_scope, tgs_plan_id, compliance_item_id, equipment_assignment_id, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, b.entry_date, b.task || '', b.representative || '', b.representative_id || null,
      b.client_representative || '',
      b.outcomes || '', b.issues || '', b.comments || '', b.stage || '',
      b.tgs_number || '', b.tgs_scope || '', b.tgs_plan_id || null,
      b.compliance_item_id || null, b.equipment_assignment_id || null,
      req.session.user.id
    );
    // Save file attachments
    const entryId = result.lastInsertRowid;
    if (req.files && req.files.length > 0) {
      const ins = db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, file_path, original_name) VALUES (?, ?, ?)');
      req.files.forEach(f => ins.run(entryId, '/data/uploads/diary/' + req.params.id + '/' + f.filename, f.originalname));
    }
    if (b.sharepoint_link && b.sharepoint_link.trim()) {
      db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, sharepoint_link) VALUES (?, ?)').run(entryId, b.sharepoint_link.trim());
    }
    req.flash('success', 'Diary entry added.');
  } catch (err) {
    console.error('[Diary] CREATE ERROR:', err.message);
    req.flash('error', 'Failed to add diary entry: ' + err.message);
  }
  res.redirect(`/jobs/${req.params.id}#diary`);
});

// Update diary entry
router.post('/:id/diary/:entryId', diaryUpload.array('attachments', 5), (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    db.prepare(`
      UPDATE site_diary_entries SET entry_date=?, task=?, representative=?, representative_id=?, client_representative=?, outcomes=?, issues=?, comments=?, stage=?, tgs_number=?, tgs_scope=?, tgs_plan_id=?, compliance_item_id=?, equipment_assignment_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ? AND job_id = ?
    `).run(
      b.entry_date, b.task || '', b.representative || '', b.representative_id || null,
      b.client_representative || '',
      b.outcomes || '', b.issues || '', b.comments || '', b.stage || '',
      b.tgs_number || '', b.tgs_scope || '', b.tgs_plan_id || null,
      b.compliance_item_id || null, b.equipment_assignment_id || null,
      req.params.entryId, req.params.id
    );
    // Save new attachments
    if (req.files && req.files.length > 0) {
      const ins = db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, file_path, original_name) VALUES (?, ?, ?)');
      req.files.forEach(f => ins.run(req.params.entryId, '/data/uploads/diary/' + req.params.id + '/' + f.filename, f.originalname));
    }
    if (b.sharepoint_link && b.sharepoint_link.trim()) {
      db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, sharepoint_link) VALUES (?, ?)').run(req.params.entryId, b.sharepoint_link.trim());
    }
    req.flash('success', 'Diary entry updated.');
  } catch (err) {
    console.error('[Diary] UPDATE ERROR:', err.message);
    req.flash('error', 'Failed to update diary entry: ' + err.message);
  }
  res.redirect(`/jobs/${req.params.id}#diary`);
});

// Delete diary entry
router.post('/:id/diary/:entryId/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM site_diary_entries WHERE id = ? AND job_id = ?').run(req.params.entryId, req.params.id);
    req.flash('success', 'Diary entry deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete diary entry: ' + err.message);
  }
  res.redirect(`/jobs/${req.params.id}#diary`);
});

module.exports = router;
