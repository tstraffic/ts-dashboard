const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

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
  const { status, job_id, client_id, item_type, view = 'all', ref } = req.query;

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

  query += ` ORDER BY c.due_date ASC, c.id ASC`;
  const items = db.prepare(query).all(...params);
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
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
    filters: { status: status || '', job_id: job_id || '', client_id: client_id || '', item_type: item_type || '', view, ref: ref || '' },
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

  // Find highest existing number with this prefix
  const rows = db.prepare("SELECT reference_number FROM compliance WHERE reference_number LIKE ? || '%'").all(prefix);
  let maxNum = 3000; // Start from 3001 to continue after existing TSTGS3xxx series
  rows.forEach(r => {
    const match = r.reference_number.match(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)'));
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  });

  res.json({ reference_number: prefix + (maxNum + 1) });
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('compliance/form', {
    title: 'New Plan / Approval', item: null, jobs, clients, users,
    user: req.session.user, prefillJobId: req.query.job_id || '', prefillClientId: req.query.client_id || '',
    returnTo: req.query.return_to || '/compliance'
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  db.prepare(`
    INSERT INTO compliance (job_id, client_id, item_type, item_types, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, designer, file_link, council_fee_paid, council_fee_amount,
      reference_number, rol_required, rol_response, bus_approvals_required, bus_approvals_response, client_pm, costs, action_required, charge_client, charge_amount, invoiced, invoice_number, police_notification, letter_drop)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status || 'not_started', b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
    b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0);
  req.flash('success', 'Item created.');
  res.redirect(b.return_to || '/compliance');
});

// Bulk operations (must be before /:id routes)
router.post('/bulk-delete', (req, res) => {
  const db = getDb();
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items selected' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM compliance WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true });
});

router.post('/bulk-status', (req, res) => {
  const db = getDb();
  const { ids, status } = req.body;
  const validStatuses = ['not_started', 'started', 'submitted', 'approved', 'rejected', 'expired'];
  if (!Array.isArray(ids) || ids.length === 0 || !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid request' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE compliance SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(status, ...ids);
  res.json({ success: true });
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  const returnTo = req.query.return_to || '/compliance';
  let documents = [];
  try { documents = db.prepare('SELECT cd.*, u.full_name as uploaded_by_name FROM compliance_documents cd LEFT JOIN users u ON cd.uploaded_by_id = u.id WHERE cd.compliance_id = ? ORDER BY cd.created_at DESC').all(item.id); } catch (e) { /* table may not exist yet */ }
  res.render('compliance/form', { title: 'Edit Plan / Approval', item, jobs, clients, users, user: req.session.user, prefillJobId: '', prefillClientId: '', returnTo, documents });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  try {
    db.prepare(`
      UPDATE compliance SET job_id=?, client_id=?, item_type=?, item_types=?, title=?, authority_approver=?, internal_approver_id=?, assigned_to_id=?,
        due_date=?, submitted_date=?, approved_date=?, expiry_date=?, status=?, notes=?, designer=?, file_link=?, council_fee_paid=?, council_fee_amount=?,
        reference_number=?, rol_required=?, rol_response=?, bus_approvals_required=?, bus_approvals_response=?, client_pm=?, costs=?, action_required=?, charge_client=?, charge_amount=?, invoiced=?, invoice_number=?, police_notification=?, letter_drop=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status, b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
      b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0, req.params.id);
    req.flash('success', 'Item updated.');
  } catch (err) {
    console.error('Compliance update error:', err.message);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  // Stay on edit page after update
  res.redirect('/compliance/' + req.params.id + '/edit' + (b.return_to ? '?return_to=' + encodeURIComponent(b.return_to) : ''));
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM compliance WHERE id = ?').run(req.params.id);
  req.flash('success', 'Item deleted.');
  res.redirect(req.body.return_to || '/compliance');
});

// Upload documents to a compliance item
router.post('/:id/upload', complianceUpload.array('documents', 10), (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const ins = db.prepare('INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const files = req.files || [];
  files.forEach(f => {
    const relPath = '/uploads/compliance/' + complianceId + '/' + f.filename;
    ins.run(complianceId, f.filename, f.originalname, relPath, f.size, f.mimetype || '', req.session.user.id);
  });

  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    const docs = db.prepare('SELECT * FROM compliance_documents WHERE compliance_id = ? ORDER BY created_at DESC').all(complianceId);
    return res.json({ success: true, count: files.length, documents: docs });
  }
  req.flash('success', `${files.length} file(s) uploaded.`);
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
  }
  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Document deleted.');
  res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit');
});

// Serve compliance uploads
router.get('/:id/documents/:filename', (req, res) => {
  const filePath = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.id, req.params.filename);
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('File not found');
});

module.exports = router;
