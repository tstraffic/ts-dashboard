const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { autoLogDiary, logStatusChange } = require('../lib/diary');

// Multer config for compliance document uploads
const complianceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.id || 'new');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const complianceUpload = multer({
  storage: complianceStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx|xls|xlsx|csv|txt|jpg|jpeg|png|gif|webp|dwg|dxf)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function toDateStr(d) { return d.toISOString().split('T')[0]; }

router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id, client_id, item_type, view = 'all', ref, date_from, date_to } = req.query;

  let query = `SELECT c.*, j.job_number, j.client as job_client,
    cl.company_name as client_name,
    u.full_name as approver_name, a.full_name as assigned_name
    FROM compliance c
    LEFT JOIN jobs j ON c.job_id = j.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users u ON c.internal_approver_id = u.id
    LEFT JOIN users a ON c.assigned_to_id = a.id
    WHERE 1=1`;
  const params = [];

  if (status && status !== 'all')       { query += ` AND c.status = ?`;     params.push(status); }
  if (job_id)                           { query += ` AND c.job_id = ?`;     params.push(job_id); }
  if (client_id)                        { query += ` AND c.client_id = ?`;  params.push(client_id); }
  if (item_type && item_type !== 'all') { query += ` AND (c.item_type = ? OR c.item_types LIKE ?)`; params.push(item_type, `%${item_type}%`); }
  if (date_from) { query += ` AND c.due_date >= ?`; params.push(date_from); }
  if (date_to)   { query += ` AND c.due_date <= ?`; params.push(date_to); }

  const today = new Date();
  let prevRef = null, nextRef = null, periodLabel = null;

  if (view === 'week') {
    const base = ref ? new Date(ref) : today;
    const ws = weekStart(base);
    const we = new Date(ws); we.setDate(ws.getDate() + 6);
    const rangeStart = toDateStr(ws), rangeEnd = toDateStr(we);
    const prevWs = new Date(ws); prevWs.setDate(ws.getDate() - 7);
    const nextWs = new Date(ws); nextWs.setDate(ws.getDate() + 7);
    prevRef = toDateStr(prevWs);
    nextRef = toDateStr(nextWs);
    periodLabel = `${ws.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })} – ${we.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    query += ` AND c.due_date BETWEEN ? AND ?`;
    params.push(rangeStart, rangeEnd);
  } else if (view === 'month') {
    const base = ref ? new Date(ref + '-01') : today;
    const ms = new Date(base.getFullYear(), base.getMonth(), 1);
    const me = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    const rangeStart = toDateStr(ms), rangeEnd = toDateStr(me);
    const prevMs = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    const nextMs = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    prevRef = `${prevMs.getFullYear()}-${String(prevMs.getMonth() + 1).padStart(2, '0')}`;
    nextRef = `${nextMs.getFullYear()}-${String(nextMs.getMonth() + 1).padStart(2, '0')}`;
    periodLabel = ms.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    query += ` AND c.due_date BETWEEN ? AND ?`;
    params.push(rangeStart, rangeEnd);
  }

  query += ` ORDER BY c.id DESC`;
  const items = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  const allItems = db.prepare('SELECT status, due_date, expiry_date FROM compliance').all();
  const todayStr = toDateStr(today);
  const soonStr = toDateStr(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000));
  const summary = {
    total: allItems.length,
    approved: allItems.filter(i => i.status === 'approved').length,
    pending: allItems.filter(i => ['not_started', 'submitted'].includes(i.status)).length,
    overdue: allItems.filter(i => i.due_date && i.due_date < todayStr && i.status !== 'approved' && i.status !== 'expired').length,
    expiringSoon: allItems.filter(i => i.status === 'approved' && i.expiry_date && i.expiry_date >= todayStr && i.expiry_date <= soonStr).length,
  };

  res.render('compliance/index', {
    title: 'Plans & Approvals',
    items, jobs, clients, users,
    filters: { status: status || '', job_id: job_id || '', client_id: client_id || '', item_type: item_type || '', view, ref: ref || '', date_from: date_from || '', date_to: date_to || '' },
    view, periodLabel, prevRef, nextRef, summary,
    user: req.session.user
  });
});

// API: Generate next reference number for a given item_type
router.get('/api/next-ref', (req, res) => {
  const db = getDb();
  const type = req.query.item_type || '';

  const prefixMap = {
    traffic_guidance: 'TSTGS',
    road_occupancy: 'TSROL',
    rol: 'TSROL',
    council_permit: 'TSCA',
    tmp_approval: 'TSTMP',
    swms_review: 'TSSWMS',
    insurance: 'TSINS',
    induction: 'TSIND',
    environmental: 'TSENV',
    utility_clearance: 'TSUC',
    spa: 'TSSPA',
    police_notification: 'TSPN',
    letter_drop: 'TSLD',
    other: 'TSOTH',
  };
  const prefix = prefixMap[type] || 'TSREF';

  // Next number after the current maximum. Monotonically increasing —
  // never re-issues a number, even if earlier ones were deleted, so
  // historical references stay stable and nothing ever jumps backwards.
  // Seeds at 3001 if there's nothing for this prefix yet.
  const rows = db.prepare("SELECT reference_number FROM compliance WHERE reference_number LIKE ? || '%'").all(prefix);
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tailRe = new RegExp('^' + escaped + '(\\d+)(?:-\\d+)?$');
  let max = 3000;
  rows.forEach(r => {
    const match = r.reference_number.match(tailRe);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  });
  const next = max + 1;

  res.json({ reference_number: prefix + next });
});

// API: Check if a reference number already exists
router.get('/api/check-ref', (req, res) => {
  const db = getDb();
  const refNum = req.query.reference_number || '';
  const excludeId = req.query.exclude_id || '';
  if (!refNum) return res.json({ exists: false });

  let query = 'SELECT id, title FROM compliance WHERE reference_number = ?';
  const params = [refNum];
  if (excludeId) { query += ' AND id != ?'; params.push(excludeId); }

  const existing = db.prepare(query).get(...params);
  res.json({ exists: !!existing, title: existing ? existing.title : '' });
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('compliance/form', {
    title: 'New Plan / Approval', item: null, jobs, clients, users,
    user: req.session.user, prefillJobId: req.query.job_id || '', prefillClientId: req.query.client_id || '',
    returnTo: req.query.return_to || '/compliance', linkedTask: null, revisions: []
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  const result = db.prepare(`
    INSERT INTO compliance (job_id, client_id, item_type, item_types, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, designer, file_link, council_fee_paid, council_fee_amount,
      reference_number, rol_required, rol_response, bus_approvals_required, bus_approvals_response, client_pm, costs, action_required, charge_client, charge_amount, invoiced, invoice_number, police_notification, letter_drop,
      tmp_response, spa_response, sza_response, council_response, tgs_response, police_response, letter_drop_response,
      tgs_quantity, received_date, revision_required, revision_count, start_date, finish_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status || 'not_started', b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid === '1' || b.council_fee_paid === 1 ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
    b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client === '1' || b.charge_client === 1 ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced === '1' || b.invoiced === 1 ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0,
    b.tmp_response || '', b.spa_response || '', b.sza_response || '', b.council_response || '', b.tgs_response || '', b.police_response || '', b.letter_drop_response || '',
    parseInt(b.tgs_quantity) || 1, b.received_date || null, b.revision_required ? 1 : 0, 0, b.start_date || null, b.finish_date || null);

  // Auto-create linked task when someone is assigned
  const complianceId = result.lastInsertRowid;
  if (b.assigned_to_id && b.status !== 'approved') {
    try {
      const typeLabels = { traffic_guidance: 'TGS', road_occupancy: 'ROL', rol: 'ROL', council_permit: 'Council Permit', tmp_approval: 'TMP', swms_review: 'SWMS', insurance: 'Insurance', induction: 'Induction', environmental: 'Environmental', utility_clearance: 'Utility Clearance', spa: 'SPA', sza: 'SZA', police_notification: 'Police Notification', letter_drop: 'Letter Drop', bus_approval: 'Bus Approval', other: 'Other' };
      const typeLabel = typesArr.map(t => typeLabels[t] || t).join(' / ') || 'Plan';
      const taskTitle = `${typeLabel}: ${b.title || 'Compliance Item'}`;
      db.prepare(`
        INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes, created_by, compliance_id)
        VALUES (?, 'planning', ?, ?, ?, ?, 'not_started', 'medium', 'one_off', ?, ?, ?)
      `).run(
        b.job_id || null,
        taskTitle,
        `Auto-created from Plans & Approvals. Reference: ${b.reference_number || 'N/A'}`,
        b.assigned_to_id,
        b.due_date || new Date().toISOString().split('T')[0],
        b.action_required || '',
        req.session.user ? req.session.user.id : null,
        complianceId
      );
    } catch (taskErr) {
      console.error('[Compliance] Auto-task creation error:', taskErr.message);
    }
  }

  // Auto-log to site diary
  const typeLabelsForDiary = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council Permit', spa: 'SPA', sza: 'SZA', bus_approval: 'Bus Approval', police_notification: 'Police Notification', letter_drop: 'Letter Drop' };
  const typeLabel = typesArr.map(t => typeLabelsForDiary[t] || t).join(' / ') || 'Plan';
  autoLogDiary(db, {
    jobId: b.job_id,
    complianceItemId: complianceId,
    summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${typeLabel} created: ${b.title || 'Untitled'}. Ref: ${b.reference_number || 'N/A'}. Status: ${b.status || 'not_started'}.`,
    userId: req.session.user ? req.session.user.id : null
  });

  req.flash('success', 'Item created.' + (b.assigned_to_id && b.status !== 'approved' ? ' Task auto-created for assignee.' : ''));
  res.redirect(b.return_to || '/compliance');
});

// Bulk operations (must be before /:id routes)
router.post('/bulk-delete', (req, res) => {
  try {
    const db = getDb();
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items selected' });
    const placeholders = ids.map(() => '?').join(',');
    // site_diary_entries.compliance_item_id is ON DELETE NO ACTION, so a linked
    // diary row blocks the delete. Detach diary links first, then delete.
    const tx = db.transaction(() => {
      db.prepare(`UPDATE site_diary_entries SET compliance_item_id = NULL WHERE compliance_item_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM compliance WHERE id IN (${placeholders})`).run(...ids);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    console.error('[compliance] bulk-delete failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/bulk-status', (req, res) => {
  const db = getDb();
  const { ids, status } = req.body;
  const validStatuses = ['not_started', 'started', 'submitted', 'approved', 'rejected', 'expired'];
  if (!Array.isArray(ids) || ids.length === 0 || !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid request' });
  const placeholders = ids.map(() => '?').join(',');
  // Log to diary before updating
  const items = db.prepare(`SELECT id, job_id, title, reference_number, item_type, item_types, status as old_status FROM compliance WHERE id IN (${placeholders})`).all(...ids);
  db.prepare(`UPDATE compliance SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(status, ...ids);
  // Sync linked tasks so approved/submitted plans close their assigned task
  // instead of building up. Same status map as the single-edit handler.
  try {
    const statusMap = { not_started: 'not_started', started: 'in_progress', submitted: 'complete', approved: 'complete', rejected: 'not_started', expired: 'not_started' };
    const taskStatus = statusMap[status] || 'not_started';
    const today = new Date().toISOString().split('T')[0];
    const completedDate = taskStatus === 'complete' ? today : null;
    db.prepare(`
      UPDATE tasks
      SET status = ?, completed_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE compliance_id IN (${placeholders}) AND deleted_at IS NULL
    `).run(taskStatus, completedDate, ...ids);
  } catch (taskErr) {
    console.error('[Compliance bulk-status] task sync failed:', taskErr.message);
  }
  // Auto-log bulk status change to diary
  items.forEach(item => {
    if (item.job_id && item.old_status !== status) {
      const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
      const types = (item.item_types || item.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
      autoLogDiary(db, {
        jobId: item.job_id, complianceItemId: item.id,
        summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} status changed (${item.reference_number || 'N/A'}): ${item.title}. ${(item.old_status || 'not_started').replace(/_/g, ' ')} → ${status.replace(/_/g, ' ')}.`,
        userId: req.session.user ? req.session.user.id : null
      });
    }
  });
  res.json({ success: true });
});

router.post('/bulk-ready-invoice', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE compliance SET ready_for_invoice = 1, ready_for_invoice_at = CURRENT_TIMESTAMP, ready_for_invoice_by = ? WHERE id IN (${placeholders})`).run(req.session.user.id, ...ids);
  // Notify admin/accounts
  try {
    const accountsUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin','finance','accounts')").all();
    const insertNotif = db.prepare("INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'invoice_ready', ?, ?, '/compliance')");
    accountsUsers.forEach(u => {
      try { insertNotif.run(u.id, ids.length + ' items ready for invoice', ids.length + ' compliance item(s) marked ready for invoice.', '/compliance'); } catch(e) {}
    });
  } catch(e) {}
  res.json({ success: true });
});

router.post('/bulk-invoiced', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items' });
  // Only admin/finance/accounts can mark as invoiced
  if (!['admin', 'finance', 'accounts'].includes(req.session.user.role)) return res.status(403).json({ error: 'Only admin/accounts can mark as invoiced' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE compliance SET invoiced = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true });
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  const returnTo = req.query.return_to || '/compliance';
  let documents = [];
  try { documents = db.prepare('SELECT cd.*, u.full_name as uploaded_by_name FROM compliance_documents cd LEFT JOIN users u ON cd.uploaded_by_id = u.id WHERE cd.compliance_id = ? ORDER BY cd.created_at DESC').all(item.id); } catch (e) { /* table may not exist yet */ }
  let linkedTask = null;
  try { linkedTask = db.prepare('SELECT t.id, t.title, t.status, t.owner_id, u.full_name as owner_name FROM tasks t LEFT JOIN users u ON t.owner_id = u.id WHERE t.compliance_id = ? AND t.deleted_at IS NULL').get(item.id); } catch (e) { /* column may not exist yet */ }
  let revisions = [];
  try { revisions = db.prepare('SELECT * FROM compliance_revisions WHERE compliance_id = ? ORDER BY revision_number ASC').all(item.id); } catch (e) { /* table may not exist yet */ }
  res.render('compliance/form', { title: 'Edit Plan / Approval', item, jobs, clients, users, user: req.session.user, prefillJobId: '', prefillClientId: '', returnTo, documents, linkedTask, revisions });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  // Load old item to detect changes for diary logging
  const oldItem = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  try {
    // Recalculate revision_count from revisions table
    let revCount = 0;
    try { revCount = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(req.params.id)?.c || 0; } catch(e) {}
    db.prepare(`
      UPDATE compliance SET job_id=?, client_id=?, item_type=?, item_types=?, title=?, authority_approver=?, internal_approver_id=?, assigned_to_id=?,
        due_date=?, submitted_date=?, approved_date=?, expiry_date=?, status=?, notes=?, designer=?, file_link=?, council_fee_paid=?, council_fee_amount=?,
        reference_number=?, rol_required=?, rol_response=?, bus_approvals_required=?, bus_approvals_response=?, client_pm=?, costs=?, action_required=?, charge_client=?, charge_amount=?, invoiced=?, invoice_number=?, police_notification=?, letter_drop=?,
        tmp_response=?, spa_response=?, sza_response=?, council_response=?, tgs_response=?, police_response=?, letter_drop_response=?,
        tgs_quantity=?, received_date=?, revision_required=?, revision_count=?, start_date=?, finish_date=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status, b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid === '1' || b.council_fee_paid === 1 ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
      b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client === '1' || b.charge_client === 1 ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced === '1' || b.invoiced === 1 ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0,
      b.tmp_response || '', b.spa_response || '', b.sza_response || '', b.council_response || '', b.tgs_response || '', b.police_response || '', b.letter_drop_response || '',
      parseInt(b.tgs_quantity) || 1, b.received_date || null, b.revision_required ? 1 : 0, revCount, b.start_date || null, b.finish_date || null,
      req.params.id);

    // Sync linked task: create if new assignee, update if exists, complete if plan approved
    try {
      const existingTask = db.prepare('SELECT id, status FROM tasks WHERE compliance_id = ? AND deleted_at IS NULL').get(req.params.id);
      const typeLabels = { traffic_guidance: 'TGS', road_occupancy: 'ROL', rol: 'ROL', council_permit: 'Council Permit', tmp_approval: 'TMP', swms_review: 'SWMS', insurance: 'Insurance', induction: 'Induction', environmental: 'Environmental', utility_clearance: 'Utility Clearance', spa: 'SPA', sza: 'SZA', police_notification: 'Police Notification', letter_drop: 'Letter Drop', bus_approval: 'Bus Approval', other: 'Other' };
      const typeLabel = typesArr.map(t => typeLabels[t] || t).join(' / ') || 'Plan';
      const taskTitle = `${typeLabel}: ${b.title || 'Compliance Item'}`;

      // Map compliance status → task status (single source of truth)
      const statusMap = { not_started: 'not_started', started: 'in_progress', submitted: 'complete', approved: 'complete', rejected: 'not_started', expired: 'not_started' };
      const mappedTaskStatus = statusMap[b.status] || 'not_started';
      const isTaskComplete = mappedTaskStatus === 'complete';
      const today = new Date().toISOString().split('T')[0];

      if (existingTask) {
        // Always sync task status + title to match compliance
        db.prepare(`UPDATE tasks SET title=?, status=?, completed_date=?, owner_id=COALESCE(?, owner_id), due_date=COALESCE(?, due_date), job_id=COALESCE(?, job_id), notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(taskTitle, mappedTaskStatus, isTaskComplete ? today : null,
            b.assigned_to_id || null, b.due_date || null, b.job_id || null,
            b.action_required || '', existingTask.id);
      } else if (b.assigned_to_id) {
        // Create new linked task with correct initial status
        db.prepare(`
          INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, completed_date, priority, task_type, notes, created_by, compliance_id)
          VALUES (?, 'planning', ?, ?, ?, ?, ?, ?, 'medium', 'one_off', ?, ?, ?)
        `).run(
          b.job_id || null,
          taskTitle,
          `Auto-created from Plans & Approvals. Reference: ${b.reference_number || 'N/A'}`,
          b.assigned_to_id,
          b.due_date || today,
          mappedTaskStatus,
          isTaskComplete ? today : null,
          b.action_required || '',
          req.session.user ? req.session.user.id : null,
          req.params.id
        );
      }
    } catch (taskErr) {
      console.error('[Compliance] Auto-task sync error:', taskErr.message);
    }

    // Auto-log changes to site diary with user name
    if (oldItem) {
      const userName = req.session.user ? req.session.user.full_name : 'System';
      const changes = [];
      if (oldItem.status !== b.status) changes.push(`Status: ${(oldItem.status || 'not_started').replace(/_/g, ' ')} → ${(b.status || '').replace(/_/g, ' ')}`);
      if ((oldItem.title || '') !== (b.title || '')) changes.push(`Title: ${b.title}`);
      if ((oldItem.submitted_date || '') !== (b.submitted_date || '')) changes.push(`Submitted: ${b.submitted_date || 'cleared'}`);
      if ((oldItem.approved_date || '') !== (b.approved_date || '')) changes.push(`Approved: ${b.approved_date || 'cleared'}`);
      if ((oldItem.received_date || '') !== (b.received_date || '')) changes.push(`Received: ${b.received_date || 'cleared'}`);
      if ((oldItem.start_date || '') !== (b.start_date || '')) changes.push(`Start date: ${b.start_date || 'cleared'}`);
      if ((oldItem.finish_date || '') !== (b.finish_date || '')) changes.push(`Finish date: ${b.finish_date || 'cleared'}`);
      if ((oldItem.designer || '') !== (b.designer || '')) changes.push(`Designer: ${b.designer || 'unassigned'}`);
      if ((oldItem.reference_number || '') !== (b.reference_number || '')) changes.push(`Ref: ${b.reference_number}`);
      if ((oldItem.client_pm || '') !== (b.client_pm || '')) changes.push(`Client PM: ${b.client_pm || 'cleared'}`);
      if ((oldItem.file_link || '') !== (b.file_link || '')) changes.push(`File link updated`);
      if ((oldItem.notes || '') !== (b.notes || '')) changes.push(`Notes updated`);
      if (String(oldItem.assigned_to_id || '') !== String(b.assigned_to_id || '')) {
        const newAssignee = b.assigned_to_id ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(b.assigned_to_id) || {}).full_name || 'Unknown' : 'Unassigned';
        changes.push(`Assigned to: ${newAssignee}`);
      }
      if (String(oldItem.internal_approver_id || '') !== String(b.internal_approver_id || '')) {
        const newApprover = b.internal_approver_id ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(b.internal_approver_id) || {}).full_name || 'Unknown' : 'None';
        changes.push(`Approver: ${newApprover}`);
      }
      if (oldItem.revision_required != (b.revision_required ? 1 : 0)) changes.push(b.revision_required ? 'Revision required flagged' : 'Revision required cleared');
      if (changes.length > 0) {
        const diaryTypeLabels = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council Permit', spa: 'SPA', sza: 'SZA', bus_approval: 'Bus Approval', police_notification: 'Police Notification', letter_drop: 'Letter Drop' };
        const diaryTypeLabel = typesArr.map(t => diaryTypeLabels[t] || t).join(' / ') || 'Plan';
        autoLogDiary(db, {
          jobId: b.job_id || oldItem.job_id,
          complianceItemId: parseInt(req.params.id),
          summary: `[${userName}] ${diaryTypeLabel} updated (${b.reference_number || oldItem.reference_number || 'N/A'}): ${b.title || oldItem.title}. ${changes.join('. ')}.`,
          userId: req.session.user ? req.session.user.id : null
        });
        // Notify relevant users on status change
        if (oldItem.status !== b.status) {
          logStatusChange(db, {
            jobId: b.job_id || oldItem.job_id,
            entityType: 'compliance',
            entityLabel: `${diaryTypeLabel} ${b.reference_number || oldItem.reference_number || b.title || oldItem.title}`,
            oldStatus: oldItem.status,
            newStatus: b.status,
            userId: req.session.user ? req.session.user.id : null,
            userName: req.session.user ? req.session.user.full_name : 'System'
          });
        }
      }
    }

    req.flash('success', 'Item updated.');
  } catch (err) {
    console.error('Compliance update error:', err.message);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  // Return the user where they came from (job page, register, etc.) — fall back to the edit page.
  const returnTo = b.return_to && b.return_to !== '/compliance' ? b.return_to : '/compliance/' + req.params.id + '/edit';
  res.redirect(returnTo);
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      db.prepare('UPDATE site_diary_entries SET compliance_item_id = NULL WHERE compliance_item_id = ?').run(req.params.id);
      db.prepare('DELETE FROM compliance WHERE id = ?').run(req.params.id);
    });
    tx();
    req.flash('success', 'Item deleted.');
  } catch (e) {
    console.error('[compliance] single delete failed:', e.message);
    req.flash('error', 'Failed to delete: ' + e.message);
  }
  res.redirect(req.body.return_to || '/compliance');
});

// Mark as ready for invoice
router.post('/:id/ready-for-invoice', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT c.*, j.job_number FROM compliance c LEFT JOIN jobs j ON c.job_id = j.id WHERE c.id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }

  db.prepare('UPDATE compliance SET ready_for_invoice = 1, ready_for_invoice_at = CURRENT_TIMESTAMP, ready_for_invoice_by = ? WHERE id = ?')
    .run(req.session.user.id, req.params.id);

  // Notify admin and accounts users
  try {
    const accountsUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin','finance','accounts')").all();
    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link)
      VALUES (?, 'invoice_ready', ?, ?, ?)
    `);
    const title = 'Ready for Invoice: ' + item.title;
    const message = (item.job_number ? item.job_number + ' — ' : '') + item.title + ' is ready to be invoiced.';
    const link = '/compliance/' + req.params.id + '/edit';
    accountsUsers.forEach(u => {
      try { insertNotif.run(u.id, title, message, link); } catch(e) {}
    });
  } catch(e) { console.error('[Compliance] Notification error:', e.message); }

  req.flash('success', 'Marked as ready for invoice. Admin/accounts team notified.');
  res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit');
});

// Unmark ready for invoice
router.post('/:id/unmark-invoice', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE compliance SET ready_for_invoice = 0, ready_for_invoice_at = NULL, ready_for_invoice_by = NULL WHERE id = ?').run(req.params.id);
  req.flash('success', 'Invoice mark removed.');
  res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit');
});

// Upload documents to a compliance item
router.post('/:id/upload', complianceUpload.array('documents', 10), (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) {
    req.flash('error', 'Item not found.');
    return res.redirect('/compliance');
  }

  try {
    const ins = db.prepare('INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const files = req.files || [];
    console.log(`[Compliance] Upload ${files.length} file(s) for item ${complianceId}`);
    files.forEach(f => {
      console.log(`  File: ${f.originalname} -> ${f.path} (${f.size} bytes)`);
      const relPath = '/data/uploads/compliance/' + complianceId + '/' + f.filename;
      ins.run(complianceId, f.filename, f.originalname, relPath, f.size, f.mimetype || '', req.session.user.id);
    });

    if (files.length === 0) {
      req.flash('error', 'No files selected. Please choose files to upload.');
    } else {
      req.flash('success', `${files.length} file(s) uploaded.`);
      // Audit trail: log upload to site diary
      const compItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
      if (compItem && compItem.job_id) {
        const userName = req.session.user ? req.session.user.full_name : 'System';
        const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
        const typeLabel = (compItem.item_types || compItem.item_type || '').split(',').map(t => typeMap[t.trim()] || t.trim()).join(' / ');
        const fileNames = files.map(f => f.originalname).join(', ');
        autoLogDiary(db, {
          jobId: compItem.job_id, complianceItemId: parseInt(complianceId),
          summary: `[${userName}] Uploaded ${files.length} file(s) to ${typeLabel} ${compItem.reference_number || compItem.title}: ${fileNames}`,
          userId: req.session.user ? req.session.user.id : null
        });
      }
    }
  } catch (err) {
    console.error('[Compliance] Upload error:', err.message);
    req.flash('error', 'Upload failed: ' + err.message);
  }
  res.redirect(req.body.return_to || '/compliance/' + complianceId + '/edit');
});

// Delete a compliance document
router.post('/:id/documents/:docId/delete', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM compliance_documents WHERE id = ? AND compliance_id = ?').get(req.params.docId, req.params.id);
  if (doc) {
    const fullPath = path.join(__dirname, '..', 'data', doc.file_path);
    try { fs.unlinkSync(fullPath); } catch (e) { /* file may not exist */ }
    db.prepare('DELETE FROM compliance_documents WHERE id = ?').run(doc.id);
    // Audit trail: log deletion to site diary
    const compItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(req.params.id);
    if (compItem && compItem.job_id) {
      const userName = req.session.user ? req.session.user.full_name : 'System';
      const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
      const typeLabel = (compItem.item_types || compItem.item_type || '').split(',').map(t => typeMap[t.trim()] || t.trim()).join(' / ');
      autoLogDiary(db, {
        jobId: compItem.job_id, complianceItemId: parseInt(req.params.id),
        summary: `[${userName}] Deleted document from ${typeLabel} ${compItem.reference_number || compItem.title}: ${doc.original_name}`,
        userId: req.session.user ? req.session.user.id : null
      });
    }
  }
  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Document deleted.');
  res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit');
});

// Add a revision to a compliance item
router.post('/:id/revisions', (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }

  const b = req.body;
  // Get next revision number
  const maxRev = db.prepare('SELECT MAX(revision_number) as m FROM compliance_revisions WHERE compliance_id = ?').get(complianceId)?.m || 0;
  const clientIssued = b.client_issued === '1' || b.client_issued === 'on' ? 1 : 0;
  db.prepare('INSERT INTO compliance_revisions (compliance_id, revision_number, revision_date, notes, client_issued) VALUES (?, ?, ?, ?, ?)')
    .run(complianceId, maxRev + 1, b.revision_date || null, b.revision_notes || '', clientIssued);

  // Update revision_count on parent
  const count = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(complianceId).c;
  db.prepare('UPDATE compliance SET revision_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(count, complianceId);

  // Auto-log revision to site diary
  const revItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
  if (revItem) {
    const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
    const types = (revItem.item_types || revItem.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
    autoLogDiary(db, {
      jobId: revItem.job_id,
      complianceItemId: parseInt(complianceId),
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} revision ${maxRev + 1} added (${revItem.reference_number || 'N/A'}): ${revItem.title}.${clientIssued ? ' [CLIENT ISSUED]' : ''} ${b.revision_notes || ''}`.trim(),
      userId: req.session.user ? req.session.user.id : null
    });
  }

  req.flash('success', 'Revision ' + (maxRev + 1) + ' added.');
  res.redirect(b.return_to || '/compliance/' + complianceId + '/edit');
});

// Edit a revision
router.post('/:id/revisions/:revId/edit', (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const revId = req.params.revId;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }

  const rev = db.prepare('SELECT * FROM compliance_revisions WHERE id = ? AND compliance_id = ?').get(revId, complianceId);
  if (!rev) { req.flash('error', 'Revision not found.'); return res.redirect('/compliance/' + complianceId + '/edit'); }

  const b = req.body;
  const clientIssued = b.client_issued === '1' || b.client_issued === 'on' ? 1 : 0;
  db.prepare('UPDATE compliance_revisions SET revision_date = ?, notes = ?, client_issued = ? WHERE id = ? AND compliance_id = ?')
    .run(b.revision_date || null, b.revision_notes || '', clientIssued, revId, complianceId);

  // Auto-log edit to site diary
  const revItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
  if (revItem) {
    const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
    const types = (revItem.item_types || revItem.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
    autoLogDiary(db, {
      jobId: revItem.job_id,
      complianceItemId: parseInt(complianceId),
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} revision ${rev.revision_number} edited (${revItem.reference_number || 'N/A'}): ${revItem.title}.${clientIssued ? ' [CLIENT ISSUED]' : ''} ${b.revision_notes || ''}`.trim(),
      userId: req.session.user ? req.session.user.id : null
    });
  }

  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Revision ' + rev.revision_number + ' updated.');
  res.redirect(b.return_to || '/compliance/' + complianceId + '/edit');
});

// Delete a revision
router.post('/:id/revisions/:revId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM compliance_revisions WHERE id = ? AND compliance_id = ?').run(req.params.revId, req.params.id);

  // Update revision_count on parent
  const count = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(req.params.id)?.c || 0;
  db.prepare('UPDATE compliance SET revision_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(count, req.params.id);

  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Revision deleted.');
  res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit');
});

// Serve compliance uploads
router.get('/:id/documents/:filename', (req, res) => {
  const filePath = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.id, req.params.filename);
  console.log('[Compliance] Download:', filePath, 'exists:', fs.existsSync(filePath));
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('File not found');
});

module.exports = router;
