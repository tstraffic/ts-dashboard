// /risk-assessments — Risk Assessment register (templates + job-linked docs).
// Mirrors the SWMS module 1:1 — templates renew every 3 months, job-linked
// renew every 6 months, expiry reminders share the same notifier loop.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

const RA_DIR = path.join(__dirname, '..', 'data', 'uploads', 'risk-assessments');
if (!fs.existsSync(RA_DIR)) fs.mkdirSync(RA_DIR, { recursive: true });

const raStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RA_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const raUpload = multer({
  storage: raStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx?|xlsx?|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  }
});

const KIND_LABELS = { template: 'Template', job: 'Job-linked' };
const STATUS_LABELS = { draft: 'Draft', active: 'Active', archived: 'Archived' };
const STATUS_VALUES = ['draft', 'active', 'archived'];
const KIND_VALUES = ['template', 'job'];
const CYCLE_MONTHS = { template: 3, job: 6 };

function defaultExpiryFor(kind, baseDate = new Date()) {
  const months = CYCLE_MONTHS[kind] || 6;
  const d = new Date(baseDate.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function loadFormChoices(db) {
  return {
    jobs: db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all(),
    users: db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all(),
  };
}

// GET /risk-assessments — register list (split into Templates + Job-linked sections)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  let where = '1=1';
  const params = [];
  if (status && STATUS_VALUES.includes(status)) { where += ' AND s.status = ?'; params.push(status); }
  if (job_id) { where += ' AND s.job_id = ?'; params.push(parseInt(job_id, 10) || 0); }

  const sql = `
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM risk_assessments s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE ${where}
    ORDER BY s.created_at DESC
  `;
  const all = db.prepare(sql).all(...params);
  const templates = all.filter(r => r.kind === 'template');
  const jobLinked = all.filter(r => r.kind === 'job');

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'template' THEN 1 ELSE 0 END) AS templates,
      SUM(CASE WHEN kind = 'job'      THEN 1 ELSE 0 END) AS job_linked,
      SUM(CASE WHEN status = 'draft'  THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < date('now')      THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date BETWEEN date('now') AND date('now','+30 days') THEN 1 ELSE 0 END) AS expiring_soon
    FROM risk_assessments
  `).get();

  res.render('risk-assessments/index', {
    title: 'Risk Assessment Register', currentPage: 'risk-assessments',
    templates, jobLinked, counts,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    filters: { status: status || 'all', job_id: job_id || '' },
  });
});

// GET /risk-assessments/new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const choices = loadFormChoices(db);
  res.render('risk-assessments/form', {
    title: 'New Risk Assessment', currentPage: 'risk-assessments',
    ra: null, isEdit: false,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: req.query.job_id || '',
    prefillKind: req.query.kind === 'template' ? 'template' : 'job',
    ...choices,
  });
});

// POST /risk-assessments — create (with optional file)
router.post('/', raUpload.single('ra_file'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/risk-assessments/new');
    }
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : 'job';
    const filePath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : '';
    const fileName = req.file ? req.file.originalname : '';
    let status = STATUS_VALUES.includes(b.status) ? b.status : (filePath ? 'active' : 'draft');

    const expiryDate = (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) ? b.expiry_date : defaultExpiryFor(kind);
    const r = db.prepare(`
      INSERT INTO risk_assessments (title, description, kind, status, job_id, owner_id, file_path, file_original_name, notes, expiry_date, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title,
      String(b.description || '').trim(),
      kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      req.session.user ? req.session.user.id : null
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'risk_assessment', entityId: r.lastInsertRowid, entityLabel: title, details: kind, ip: req.ip }); } catch (e) {}
    req.flash('success', kind === 'template' ? 'Risk Assessment template imported.' : 'Risk Assessment created.');
    return res.redirect('/risk-assessments/' + r.lastInsertRowid);
  } catch (err) {
    console.error('[risk-assessments POST]', err);
    req.flash('error', 'Could not create Risk Assessment: ' + (err && err.message || 'unknown error'));
    return res.redirect('/risk-assessments/new');
  }
});

// GET /risk-assessments/:id — detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const ra = db.prepare(`
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM risk_assessments s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!ra) { req.flash('error', 'Risk Assessment not found.'); return res.redirect('/risk-assessments'); }
  res.render('risk-assessments/show', {
    title: ra.title, currentPage: 'risk-assessments',
    ra,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /risk-assessments/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
  if (!ra) { req.flash('error', 'Risk Assessment not found.'); return res.redirect('/risk-assessments'); }
  const choices = loadFormChoices(db);
  res.render('risk-assessments/form', {
    title: 'Edit Risk Assessment', currentPage: 'risk-assessments',
    ra, isEdit: true,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: '', prefillKind: ra.kind,
    ...choices,
  });
});

// POST /risk-assessments/:id — update (file optional; replaces if uploaded)
router.post('/:id', raUpload.single('ra_file'), (req, res) => {
  try {
    const db = getDb();
    const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
    if (!ra) { req.flash('error', 'Risk Assessment not found.'); return res.redirect('/risk-assessments'); }
    const b = req.body;
    const title = String(b.title || '').trim() || ra.title;
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : ra.kind;
    let filePath = ra.file_path;
    let fileName = ra.file_original_name;
    if (req.file) {
      filePath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      fileName = req.file.originalname;
    }
    const status = STATUS_VALUES.includes(b.status) ? b.status : ra.status;
    let expiryDate = ra.expiry_date;
    if (b.expiry_date === '') {
      expiryDate = defaultExpiryFor(kind);
    } else if (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) {
      expiryDate = b.expiry_date;
    }
    const expiryChanged = String(expiryDate || '') !== String(ra.expiry_date || '');
    db.prepare(`
      UPDATE risk_assessments SET title = ?, description = ?, kind = ?, status = ?, job_id = ?, owner_id = ?,
        file_path = ?, file_original_name = ?, notes = ?, expiry_date = ?,
        last_reminded_at = CASE WHEN ? = 1 THEN NULL ELSE last_reminded_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, String(b.description || '').trim(), kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      expiryChanged ? 1 : 0,
      ra.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'risk_assessment', entityId: ra.id, entityLabel: title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'Risk Assessment updated.');
    return res.redirect('/risk-assessments/' + ra.id);
  } catch (err) {
    console.error('[risk-assessments PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/risk-assessments/' + req.params.id + '/edit');
  }
});

// GET /risk-assessments/:id/file — auth-gated download
router.get('/:id/file', (req, res) => {
  const db = getDb();
  const ra = db.prepare("SELECT file_path, file_original_name FROM risk_assessments WHERE id = ?").get(req.params.id);
  if (!ra || !ra.file_path) { req.flash('error', 'No file attached.'); return res.redirect('/risk-assessments/' + req.params.id); }
  const abs = path.join(__dirname, '..', ra.file_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing on disk.'); return res.redirect('/risk-assessments/' + req.params.id); }
  return res.download(abs, ra.file_original_name || path.basename(abs));
});

// POST /risk-assessments/:id/delete
router.post('/:id/delete', (req, res) => {
  try {
    const db = getDb();
    const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
    if (!ra) { req.flash('error', 'Risk Assessment not found.'); return res.redirect('/risk-assessments'); }
    db.prepare("DELETE FROM risk_assessments WHERE id = ?").run(ra.id);
    try { logActivity({ user: req.session.user, action: 'delete', entityType: 'risk_assessment', entityId: ra.id, entityLabel: ra.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'Risk Assessment deleted.');
    return res.redirect('/risk-assessments');
  } catch (err) {
    console.error('[risk-assessments DELETE]', err);
    req.flash('error', 'Delete failed.');
    return res.redirect('/risk-assessments');
  }
});

module.exports = router;
