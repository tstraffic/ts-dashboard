/**
 * Worker portal — custom checklists.
 *
 * Admin authors a checklist on /checklists, ticks "Visible to workers"
 * and publishes a revision. The published revision shows up here for
 * workers to fill in. Submissions land in custom_checklist_responses
 * keyed by template + revision_number, so a future revision doesn't
 * change historical data.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/forms/custom — list templates available to fill in
router.get('/forms/custom', (req, res) => {
  const db = getDb();
  let templates = [];
  try {
    templates = db.prepare(`
      SELECT t.id, t.name, t.description, t.published_revision, t.require_signature, t.require_photo,
        (SELECT COUNT(*) FROM custom_checklist_responses r WHERE r.template_id = t.id AND r.crew_member_id = ?) AS my_submissions
      FROM checklist_templates t
      WHERE t.worker_visible = 1
        AND t.status = 'active'
        AND t.published_revision IS NOT NULL
        AND t.published_revision > 0
      ORDER BY t.sort_order ASC, t.name ASC
    `).all(req.session.worker.id);
  } catch (e) { /* migration 150 not yet applied */ }

  res.render('worker/forms-custom', {
    title: 'Custom Checklists',
    currentPage: 'forms',
    templates,
  });
});

// GET /w/forms/custom/:id — fill-in form for the latest published revision
router.get('/forms/custom/:id', (req, res) => {
  const db = getDb();
  const template = db.prepare(`
    SELECT id, name, description, published_revision, worker_visible, status, require_signature, require_photo
    FROM checklist_templates WHERE id = ?
  `).get(req.params.id);
  if (!template || !template.worker_visible || template.status !== 'active' || !template.published_revision) {
    req.flash('error', 'Checklist is not available.');
    return res.redirect('/w/forms/custom');
  }
  const rev = db.prepare(`
    SELECT * FROM checklist_template_revisions WHERE template_id = ? AND revision_number = ?
  `).get(template.id, template.published_revision);
  if (!rev) {
    req.flash('error', 'Published revision missing.');
    return res.redirect('/w/forms/custom');
  }
  let items = [];
  try { items = JSON.parse(rev.items_json || '[]'); } catch (e) { items = []; }

  // Group items by section so the form reads as a structured doc.
  const sections = [];
  const byKey = {};
  items.forEach(it => {
    const key = it.section || '';
    if (!byKey[key]) { byKey[key] = { name: key, items: [] }; sections.push(byKey[key]); }
    byKey[key].items.push(it);
  });

  // Optional ?allocationId= so the submission can be linked to a shift.
  const allocationId = req.query.allocationId ? Number(req.query.allocationId) : null;
  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, req.session.worker.id);
  }

  res.render('worker/forms-custom-fill', {
    title: template.name,
    currentPage: 'forms',
    template, revision: rev, sections, allocation,
  });
});

// POST /w/forms/custom/:id — accept a submission against the latest revision
router.post('/forms/custom/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const template = db.prepare(`
    SELECT id, name, worker_visible, status, published_revision, require_signature
    FROM checklist_templates WHERE id = ?
  `).get(req.params.id);
  if (!template || !template.worker_visible || template.status !== 'active' || !template.published_revision) {
    req.flash('error', 'Checklist is not available.');
    return res.redirect('/w/forms/custom');
  }

  const allocationId = req.body.allocation_id ? Number(req.body.allocation_id) : null;
  const bookingId    = req.body.booking_id    ? Number(req.body.booking_id)    : null;
  const signature    = req.body.signature_data || null;

  if (template.require_signature && !signature) {
    req.flash('error', 'Signature is required for this checklist.');
    return res.redirect(`/w/forms/custom/${template.id}` + (allocationId ? `?allocationId=${allocationId}` : ''));
  }

  // Pick out keys named "answer_<itemId>" → build answers JSON.
  const answers = {};
  Object.keys(req.body || {}).forEach(k => {
    if (!k.startsWith('answer_')) return;
    const id = k.slice('answer_'.length);
    answers[id] = req.body[k];
  });

  db.prepare(`
    INSERT INTO custom_checklist_responses
      (template_id, revision_number, crew_member_id, allocation_id, booking_id, answers_json, signature_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(template.id, template.published_revision, worker.id, allocationId, bookingId, JSON.stringify(answers), signature);

  req.flash('success', `${template.name} submitted.`);
  if (allocationId) return res.redirect('/w/jobs/' + allocationId + '?tab=forms');
  res.redirect('/w/forms/custom');
});

module.exports = router;
