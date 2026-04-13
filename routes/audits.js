const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { AUDIT_SECTIONS, SCORE_GROUPS, computeScore } = require('../lib/auditQuestions');
const { autoLogDiary } = require('../lib/diary');

// ---- Multer storage: data/uploads/audits/{auditId}/ ----
const auditStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const auditId = req.params.id;
    const dest = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(auditId));
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const safe = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    cb(null, safe);
  },
});
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/plain)$/i;
const auditUpload = multer({
  storage: auditStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

function parseJson(s, fallback) {
  try { return JSON.parse(s || ''); } catch (e) { return fallback; }
}

// Normalise req.body into responses_json + nonconformances_json
function buildResponsesFromBody(b) {
  const responses = {};
  for (const section of AUDIT_SECTIONS) {
    section.items.forEach((_, idx) => {
      const key = `${section.key}.${idx + 1}`;
      const raw = b[`q_${key}_state`];
      const state = ['yes', 'no', 'na'].includes(raw) ? raw : '';
      const notes = (b[`q_${key}_notes`] || '').trim();
      if (state || notes) {
        responses[key] = { state, notes };
      }
    });
  }
  // Section-level comments
  const sectionComments = {};
  for (const section of AUDIT_SECTIONS) {
    const c = (b[`section_${section.key}_comments`] || '').trim();
    if (c) sectionComments[section.key] = c;
  }
  return { responses, sectionComments };
}

function buildNonconformancesFromBody(b) {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const issue = (b[`nc_${i}_issue`] || '').trim();
    if (!issue) continue;
    rows.push({
      issue,
      risk: (b[`nc_${i}_risk`] || '').trim(),
      action: (b[`nc_${i}_action`] || '').trim(),
      responsible: (b[`nc_${i}_responsible`] || '').trim(),
      due_date: (b[`nc_${i}_due`] || '').trim(),
      closed: !!b[`nc_${i}_closed`],
    });
  }
  return rows;
}

// GET / — list
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  let where = '1=1';
  const params = [];
  if (status && status !== 'all') { where += ' AND a.status = ?'; params.push(status); }
  if (job_id) { where += ' AND a.job_id = ?'; params.push(job_id); }

  const audits = db.prepare(`
    SELECT a.*, j.job_number, j.client as job_client, u.full_name as created_by_name
    FROM site_audits a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN users u ON a.created_by_id = u.id
    WHERE ${where}
    ORDER BY a.id DESC
  `).all(...params);

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draft,
      SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status = 'signed_off' THEN 1 ELSE 0 END) as signed_off,
      SUM(CASE WHEN overall_finding = 'fail' THEN 1 ELSE 0 END) as fail_count
    FROM site_audits
  `).get();

  res.render('audits/index', {
    title: 'Site Audits',
    audits,
    counts: counts || {},
    filters: req.query,
    user: req.session.user,
    currentPage: 'audits',
  });
});

// POST /draft — create an empty draft on first field change, return JSON {id}
// This allows per-section/per-NC/overview uploads to work immediately in the "new" flow.
router.post('/draft', (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    const result = db.prepare(`
      INSERT INTO site_audits (
        project_site, auditor_id, auditor_name,
        audit_datetime, shift, status, created_by_id
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      b.project_site || '',
      req.session.user.id,
      b.auditor_name || req.session.user.full_name || '',
      b.audit_datetime || new Date().toISOString().slice(0, 16),
      b.shift || 'day',
      req.session.user.id
    );
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('[Audits] Draft create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, job_name, client, site_address, suburb FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  res.render('audits/form', {
    title: 'New Site Audit',
    audit: null,
    responses: {},
    sectionComments: {},
    nonconformances: [],
    attachments: [],
    attachmentsByContext: {},
    sections: AUDIT_SECTIONS,
    scoreGroups: SCORE_GROUPS,
    score: computeScore({}),
    jobs,
    user: req.session.user,
    currentPage: 'audits',
    isEdit: false,
  });
});

// POST / — create
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const { responses, sectionComments } = buildResponsesFromBody(b);
    const nonconformances = buildNonconformancesFromBody(b);
    const score = computeScore(responses);

    const status = b.submit === '1' ? 'submitted' : 'draft';
    const stored = { responses, sectionComments };

    const result = db.prepare(`
      INSERT INTO site_audits (
        job_id, project_site, client, location, audit_datetime,
        auditor_id, auditor_name, supervisor_name, tgs_ref, shift, weather,
        overall_result, overall_finding,
        responses_json, nonconformances_json,
        score_total, score_max, score_percent,
        status, follow_up_required, follow_up_date, created_by_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.job_id || null, b.project_site || '', b.client || '', b.location || '',
      b.audit_datetime || '',
      req.session.user.id, b.auditor_name || req.session.user.full_name, b.supervisor_name || '',
      b.tgs_ref || '', b.shift || 'day', b.weather || '',
      b.overall_result || '', b.overall_finding || '',
      JSON.stringify(stored), JSON.stringify(nonconformances),
      score.total, score.max, score.percent,
      status, b.follow_up_required ? 1 : 0, b.follow_up_date || null,
      req.session.user.id
    );

    const newId = result.lastInsertRowid;

    // Log to site diary when audit is tied to a job
    if (b.job_id && status === 'submitted') {
      autoLogDiary(db, {
        jobId: b.job_id,
        summary: `[${req.session.user.full_name}] Site audit completed — ${score.percent}% (${b.overall_finding || 'no finding'}).`,
        userId: req.session.user.id,
      });
    }

    req.flash('success', status === 'submitted' ? 'Audit submitted.' : 'Audit saved as draft.');
    res.redirect('/audits/' + newId);
  } catch (err) {
    console.error('[Audits] Create error:', err.message, err.stack);
    req.flash('error', 'Failed to save audit: ' + err.message);
    res.redirect('/audits/new');
  }
});

// GET /:id — view
router.get('/:id', (req, res) => {
  const db = getDb();
  const audit = db.prepare(`
    SELECT a.*, j.job_number, j.client as job_client,
           creator.full_name as created_by_name,
           signer.full_name as signed_off_by_name,
           auditor.full_name as auditor_full_name
    FROM site_audits a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN users creator ON a.created_by_id = creator.id
    LEFT JOIN users signer ON a.signed_off_by_id = signer.id
    LEFT JOIN users auditor ON a.auditor_id = auditor.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }

  const stored = parseJson(audit.responses_json, {}) || {};
  const responses = stored.responses || stored; // backward-compat
  const sectionComments = stored.sectionComments || {};
  const nonconformances = parseJson(audit.nonconformances_json, []) || [];
  const score = computeScore(responses);
  const attachments = db.prepare('SELECT * FROM audit_attachments WHERE audit_id = ? ORDER BY uploaded_at DESC').all(audit.id);
  const attachmentsByContext = {};
  attachments.forEach(att => {
    const k = att.context_key || 'general';
    if (!attachmentsByContext[k]) attachmentsByContext[k] = [];
    attachmentsByContext[k].push(att);
  });

  res.render('audits/show', {
    title: 'Audit #' + audit.id,
    audit,
    responses, sectionComments, nonconformances, attachments, attachmentsByContext,
    sections: AUDIT_SECTIONS, scoreGroups: SCORE_GROUPS, score,
    user: req.session.user,
    currentPage: 'audits',
  });
});

// GET /:id/edit — edit form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  if (audit.status === 'signed_off' && (req.session.user.role || '').toLowerCase() !== 'admin') {
    req.flash('error', 'Signed-off audits can only be edited by admin.');
    return res.redirect('/audits/' + audit.id);
  }

  const stored = parseJson(audit.responses_json, {}) || {};
  const responses = stored.responses || stored;
  const sectionComments = stored.sectionComments || {};
  const nonconformances = parseJson(audit.nonconformances_json, []) || [];
  const jobs = db.prepare("SELECT id, job_number, job_name, client, site_address, suburb FROM jobs ORDER BY job_number DESC").all();
  const attachments = db.prepare('SELECT * FROM audit_attachments WHERE audit_id = ? ORDER BY uploaded_at DESC').all(audit.id);
  const attachmentsByContext = {};
  attachments.forEach(att => {
    const k = att.context_key || 'general';
    if (!attachmentsByContext[k]) attachmentsByContext[k] = [];
    attachmentsByContext[k].push(att);
  });

  res.render('audits/form', {
    title: 'Edit Audit #' + audit.id,
    audit,
    responses, sectionComments, nonconformances, attachments, attachmentsByContext,
    sections: AUDIT_SECTIONS, scoreGroups: SCORE_GROUPS,
    score: computeScore(responses),
    jobs, user: req.session.user, currentPage: 'audits',
    isEdit: true,
  });
});

// POST /:id — update
router.post('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const existing = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
    if (!existing) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }

    const { responses, sectionComments } = buildResponsesFromBody(b);
    const nonconformances = buildNonconformancesFromBody(b);
    const score = computeScore(responses);

    const newStatus = b.submit === '1' ? 'submitted' : (existing.status === 'signed_off' ? 'signed_off' : (existing.status || 'draft'));
    const stored = { responses, sectionComments };

    // Signatures: record timestamp when text changes from empty to non-empty
    const auditorSig = (b.auditor_signature_text || '').trim();
    const supervisorSig = (b.supervisor_signature_text || '').trim();
    const auditorSignedAt = auditorSig && !existing.auditor_signature_text ? new Date().toISOString() : existing.auditor_signed_at;
    const supervisorSignedAt = supervisorSig && !existing.supervisor_signature_text ? new Date().toISOString() : existing.supervisor_signed_at;

    db.prepare(`
      UPDATE site_audits SET
        job_id=?, project_site=?, client=?, location=?, audit_datetime=?,
        auditor_name=?, supervisor_name=?, tgs_ref=?, shift=?, weather=?,
        overall_result=?, overall_finding=?,
        responses_json=?, nonconformances_json=?,
        score_total=?, score_max=?, score_percent=?,
        status=?, follow_up_required=?, follow_up_date=?,
        auditor_signature_text=?, auditor_signed_at=?,
        supervisor_signature_text=?, supervisor_signed_at=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.job_id || null, b.project_site || '', b.client || '', b.location || '', b.audit_datetime || '',
      b.auditor_name || '', b.supervisor_name || '', b.tgs_ref || '', b.shift || 'day', b.weather || '',
      b.overall_result || '', b.overall_finding || '',
      JSON.stringify(stored), JSON.stringify(nonconformances),
      score.total, score.max, score.percent,
      newStatus, b.follow_up_required ? 1 : 0, b.follow_up_date || null,
      auditorSig, auditorSignedAt,
      supervisorSig, supervisorSignedAt,
      req.params.id
    );

    if (b.job_id && newStatus === 'submitted' && existing.status !== 'submitted') {
      autoLogDiary(db, {
        jobId: b.job_id,
        summary: `[${req.session.user.full_name}] Site audit submitted — ${score.percent}% (${b.overall_finding || 'no finding'}).`,
        userId: req.session.user.id,
      });
    }

    req.flash('success', 'Audit updated.');
    res.redirect('/audits/' + req.params.id);
  } catch (err) {
    console.error('[Audits] Update error:', err.message, err.stack);
    req.flash('error', 'Failed to update audit: ' + err.message);
    res.redirect('/audits/' + req.params.id + '/edit');
  }
});

// POST /:id/attachments — upload one or more files
router.post('/:id/attachments', auditUpload.array('files', 20), (req, res) => {
  const wantJson = req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  try {
    const db = getDb();
    const audit = db.prepare('SELECT id FROM site_audits WHERE id = ?').get(req.params.id);
    if (!audit) {
      if (wantJson) return res.status(404).json({ ok: false, error: 'Audit not found' });
      req.flash('error', 'Audit not found.'); return res.redirect('/audits');
    }
    if (!req.files || !req.files.length) {
      if (wantJson) return res.status(400).json({ ok: false, error: 'No files uploaded' });
      req.flash('error', 'No files uploaded.'); return res.redirect('/audits/' + req.params.id);
    }

    const context = (req.body.context_key || 'general').trim();
    const caption = (req.body.caption || '').trim();

    const insert = db.prepare(`
      INSERT INTO audit_attachments (audit_id, context_key, caption, filename, original_name, file_path, file_size, mime_type, uploaded_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const inserted = [];
    for (const f of req.files) {
      const servedPath = `/data/uploads/audits/${req.params.id}/${f.filename}`;
      const r = insert.run(audit.id, context, caption, f.filename, f.originalname, servedPath, f.size, f.mimetype, req.session.user.id);
      inserted.push({
        id: r.lastInsertRowid,
        audit_id: audit.id,
        context_key: context,
        caption, filename: f.filename, original_name: f.originalname,
        file_path: servedPath, file_size: f.size, mime_type: f.mimetype,
      });
    }

    if (wantJson) return res.json({ ok: true, attachments: inserted });
    req.flash('success', `${req.files.length} file(s) uploaded.`);
    res.redirect(req.body.return_to || ('/audits/' + req.params.id));
  } catch (err) {
    console.error('[Audits] Upload error:', err.message);
    if (wantJson) return res.status(500).json({ ok: false, error: err.message });
    req.flash('error', 'Upload failed: ' + err.message);
    res.redirect('/audits/' + req.params.id);
  }
});

// POST /:id/attachments/:attId/delete — delete an attachment
router.post('/:id/attachments/:attId/delete', (req, res) => {
  const wantJson = req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  const db = getDb();
  const att = db.prepare('SELECT * FROM audit_attachments WHERE id = ? AND audit_id = ?').get(req.params.attId, req.params.id);
  if (att) {
    try {
      const full = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(req.params.id), att.filename);
      fs.unlinkSync(full);
    } catch (e) { /* file may already be gone */ }
    db.prepare('DELETE FROM audit_attachments WHERE id = ?').run(att.id);
  }
  if (wantJson) return res.json({ ok: true });
  req.flash('success', 'Attachment deleted.');
  res.redirect(req.body.return_to || ('/audits/' + req.params.id));
});

// POST /:id/sign-off — final sign-off
router.post('/:id/sign-off', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  db.prepare(`
    UPDATE site_audits SET status='signed_off', signed_off_by_id=?, signed_off_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(req.session.user.id, req.params.id);

  if (audit.job_id) {
    autoLogDiary(db, {
      jobId: audit.job_id,
      summary: `[${req.session.user.full_name}] Site audit signed off — ${audit.score_percent}% (${audit.overall_finding || ''}).`,
      userId: req.session.user.id,
    });
  }

  req.flash('success', 'Audit signed off.');
  res.redirect('/audits/' + req.params.id);
});

// POST /:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const role = (req.session.user.role || '').toLowerCase();
  if (!['admin', 'management'].includes(role)) {
    req.flash('error', 'Only admin or management can delete audits.');
    return res.redirect('/audits/' + req.params.id);
  }
  db.prepare('DELETE FROM site_audits WHERE id = ?').run(req.params.id);
  req.flash('success', 'Audit deleted.');
  res.redirect('/audits');
});

module.exports = router;
