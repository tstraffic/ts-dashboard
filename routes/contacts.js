const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// ============================================
// CONTACTS LIST
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('cc.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.contact_type) { where.push('cc.contact_type = ?'); params.push(req.query.contact_type); }
  if (req.query.search) {
    where.push("(cc.full_name LIKE ? OR cc.company LIKE ? OR cc.email LIKE ?)");
    const s = `%${req.query.search}%`;
    params.push(s, s, s);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const contacts = db.prepare(`
    SELECT cc.*, j.job_number, j.client
    FROM client_contacts cc
    LEFT JOIN jobs j ON cc.job_id = j.id
    ${whereClause}
    ORDER BY cc.company, cc.full_name
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('contacts/index', {
    title: 'Client Contacts',
    currentPage: 'contacts',
    contacts,
    jobs,
    filters: req.query
  });
});

// ============================================
// NEW CONTACT FORM
// ============================================
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs ORDER BY job_number DESC").all();
  res.render('contacts/form', {
    title: 'New Contact',
    currentPage: 'contacts',
    contact: null,
    jobs,
    preselectedJobId: req.query.job_id || ''
  });
});

// ============================================
// CREATE CONTACT
// ============================================
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, contact_type, company, full_name, position, phone, email, notes, is_primary } = req.body;
  const result = db.prepare(`
    INSERT INTO client_contacts (job_id, contact_type, company, full_name, position, phone, email, notes, is_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job_id || null, contact_type, company, full_name, position || '', phone || '', email || '', notes || '', is_primary ? 1 : 0);

  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'contact',
    entityId: result.lastInsertRowid,
    entityLabel: `${full_name} (${company})`,
    jobId: job_id ? parseInt(job_id) : null,
    ip: req.ip
  });

  req.flash('success', `Contact ${full_name} added.`);
  res.redirect('/contacts');
});

// ============================================
// COMMUNICATION LOG (must be before /:id routes)
// ============================================
router.get('/comms', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('cl.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.comm_type) { where.push('cl.comm_type = ?'); params.push(req.query.comm_type); }
  if (req.query.follow_up === '1') { where.push('cl.follow_up_required = 1 AND cl.follow_up_done = 0'); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const comms = db.prepare(`
    SELECT cl.*, j.job_number, j.client,
           cc.full_name as contact_name, cc.company as contact_company,
           u.full_name as logged_by_name
    FROM communication_log cl
    JOIN jobs j ON cl.job_id = j.id
    LEFT JOIN client_contacts cc ON cl.contact_id = cc.id
    JOIN users u ON cl.logged_by_id = u.id
    ${whereClause}
    ORDER BY cl.comm_date DESC
    LIMIT 100
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('contacts/comms-log', {
    title: 'Communication Log',
    currentPage: 'contacts',
    comms,
    jobs,
    filters: req.query
  });
});

// ============================================
// NEW COMMUNICATION ENTRY
// ============================================
router.get('/comms/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const contacts = db.prepare('SELECT id, full_name, company FROM client_contacts ORDER BY company, full_name').all();
  res.render('contacts/comms-form', {
    title: 'Log Communication',
    currentPage: 'contacts',
    comm: null,
    jobs,
    contacts,
    preselectedJobId: req.query.job_id || ''
  });
});

// ============================================
// CREATE COMMUNICATION
// ============================================
router.post('/comms', (req, res) => {
  const db = getDb();
  const { job_id, contact_id, comm_type, direction, subject, summary, follow_up_required, follow_up_date, comm_date } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  const result = db.prepare(`
    INSERT INTO communication_log (job_id, contact_id, comm_type, direction, subject, summary, follow_up_required, follow_up_date, logged_by_id, comm_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job_id,
    contact_id || null,
    comm_type,
    direction || 'outgoing',
    subject,
    summary,
    follow_up_required ? 1 : 0,
    follow_up_date || null,
    req.session.user.id,
    comm_date
  );

  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'communication',
    entityId: result.lastInsertRowid,
    entityLabel: subject.substring(0, 50),
    jobId: parseInt(job_id),
    jobNumber: job ? job.job_number : '',
    ip: req.ip
  });

  req.flash('success', 'Communication logged.');
  res.redirect('/contacts/comms');
});

// ============================================
// MARK FOLLOW-UP DONE
// ============================================
router.post('/comms/:id/follow-up-done', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE communication_log SET follow_up_done = 1 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Follow-up marked as done.');
  res.redirect(req.get('Referer') || '/contacts/comms');
});

// ============================================
// EDIT CONTACT
// ============================================
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(req.params.id);
  if (!contact) {
    req.flash('error', 'Contact not found.');
    return res.redirect('/contacts');
  }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs ORDER BY job_number DESC").all();
  res.render('contacts/form', {
    title: `Edit ${contact.full_name}`,
    currentPage: 'contacts',
    contact,
    jobs,
    preselectedJobId: ''
  });
});

// ============================================
// UPDATE CONTACT
// ============================================
router.post('/:id', (req, res) => {
  const db = getDb();
  const { job_id, contact_type, company, full_name, position, phone, email, notes, is_primary } = req.body;
  db.prepare(`
    UPDATE client_contacts SET job_id=?, contact_type=?, company=?, full_name=?, position=?, phone=?, email=?, notes=?, is_primary=?
    WHERE id=?
  `).run(job_id || null, contact_type, company, full_name, position || '', phone || '', email || '', notes || '', is_primary ? 1 : 0, req.params.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'contact',
    entityId: parseInt(req.params.id),
    entityLabel: full_name,
    ip: req.ip
  });

  req.flash('success', 'Contact updated.');
  res.redirect('/contacts');
});

// ============================================
// DELETE CONTACT
// ============================================
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT full_name FROM client_contacts WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM client_contacts WHERE id = ?').run(req.params.id);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'contact',
    entityId: parseInt(req.params.id),
    entityLabel: contact ? contact.full_name : '',
    ip: req.ip
  });

  req.flash('success', 'Contact deleted.');
  res.redirect('/contacts');
});

module.exports = router;
