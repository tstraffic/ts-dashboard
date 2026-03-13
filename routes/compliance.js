const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

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
  if (item_type && item_type !== 'all') { query += ` AND c.item_type = ?`;  params.push(item_type); }

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
  db.prepare(`
    INSERT INTO compliance (job_id, client_id, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id || null, b.client_id || null, b.item_type, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status || 'not_started', b.notes || '');
  req.flash('success', 'Item created.');
  res.redirect(b.return_to || '/compliance');
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect('/compliance'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  const returnTo = req.query.return_to || '/compliance';
  res.render('compliance/form', { title: 'Edit Plan / Approval', item, jobs, clients, users, user: req.session.user, prefillJobId: '', prefillClientId: '', returnTo });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    UPDATE compliance SET job_id=?, client_id=?, item_type=?, title=?, authority_approver=?, internal_approver_id=?, assigned_to_id=?,
      due_date=?, submitted_date=?, approved_date=?, expiry_date=?, status=?, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(b.job_id || null, b.client_id || null, b.item_type, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status, b.notes || '', req.params.id);
  req.flash('success', 'Item updated.');
  res.redirect(b.return_to || '/compliance');
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM compliance WHERE id = ?').run(req.params.id);
  req.flash('success', 'Item deleted.');
  res.redirect(req.body.return_to || '/compliance');
});

module.exports = router;
