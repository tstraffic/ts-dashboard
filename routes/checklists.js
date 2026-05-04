const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// GET / — List all checklist templates
router.get('/', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT ct.*, u.full_name as creator_name,
      (SELECT COUNT(*) FROM checklist_template_items WHERE template_id = ct.id) as item_count
    FROM checklist_templates ct
    LEFT JOIN users u ON ct.created_by_id = u.id
    ORDER BY ct.sort_order ASC, ct.created_at DESC
  `).all();

  res.render('checklists/index', {
    title: 'Checklist Templates',
    currentPage: 'checklists',
    templates,
    user: req.session.user
  });
});

// GET /new — Create new template form
router.get('/new', (req, res) => {
  res.render('checklists/new', {
    title: 'New Checklist Template',
    currentPage: 'checklists',
    user: req.session.user
  });
});

// POST / — Save new template
router.post('/', (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  if (!name || !name.trim()) { req.flash('error', 'Template name is required.'); return res.redirect('/checklists/new'); }

  const result = db.prepare(`
    INSERT INTO checklist_templates (name, description, status, created_by_id)
    VALUES (?, ?, 'active', ?)
  `).run(name.trim(), description || '', req.session.user.id);

  logActivity({ user: req.session.user, action: 'create', entityType: 'checklist_template', entityId: result.lastInsertRowid, entityLabel: name.trim(), ip: req.ip });
  req.flash('success', `Template "${name.trim()}" created. Now add your questions.`);
  res.redirect(`/checklists/${result.lastInsertRowid}`);
});

// GET /:id — View/edit template + items
router.get('/:id', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return res.redirect('/checklists'); }

  const items = db.prepare('SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC, id ASC').all(template.id);

  // Revision history + dirty state — "dirty" means the draft items have
  // changed since the last published snapshot, so the admin needs to
  // hit Publish for workers to see the change.
  let revisions = [];
  let dirty = false;
  let responseCount = 0;
  try {
    revisions = db.prepare(`
      SELECT r.*, u.full_name AS publisher_name
      FROM checklist_template_revisions r
      LEFT JOIN users u ON u.id = r.published_by_id
      WHERE r.template_id = ?
      ORDER BY r.revision_number DESC
    `).all(template.id);
    if (revisions.length > 0) {
      const latest = revisions[0];
      const liveItems = JSON.parse(latest.items_json || '[]');
      const draftSig = JSON.stringify(items.map(i => [i.item_order, i.section, i.question, i.response_type, i.required]));
      const liveSig  = JSON.stringify((liveItems || []).map(i => [i.item_order, i.section, i.question, i.response_type, i.required]));
      dirty = (draftSig !== liveSig)
        || (latest.name !== template.name)
        || ((latest.description || '') !== (template.description || ''))
        || (!!latest.require_signature !== !!template.require_signature)
        || (!!latest.require_photo !== !!template.require_photo);
    } else {
      dirty = items.length > 0; // never published — dirty as soon as there's content
    }
    responseCount = db.prepare('SELECT COUNT(*) AS c FROM custom_checklist_responses WHERE template_id = ?').get(template.id).c;
  } catch (e) { /* legacy DB before mig 150 */ }

  res.render('checklists/show', {
    title: `Template: ${template.name}`,
    currentPage: 'checklists',
    template, items, revisions, dirty, responseCount,
    user: req.session.user
  });
});

// POST /:id/visibility — toggle worker_visible + signature/photo flags.
router.post('/:id/visibility', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT id, name FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return res.redirect('/checklists'); }
  const visible = req.body.worker_visible === '1' || req.body.worker_visible === 'on' ? 1 : 0;
  const sig = req.body.require_signature === '1' || req.body.require_signature === 'on' ? 1 : 0;
  const photo = req.body.require_photo === '1' || req.body.require_photo === 'on' ? 1 : 0;
  db.prepare(`UPDATE checklist_templates SET worker_visible = ?, require_signature = ?, require_photo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(visible, sig, photo, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'checklist_template', entityId: tpl.id, entityLabel: tpl.name, details: `Visibility: worker_visible=${visible}, sig=${sig}, photo=${photo}`, ip: req.ip });
  req.flash('success', visible ? 'Template will be visible to workers once published.' : 'Template hidden from workers.');
  res.redirect(`/checklists/${req.params.id}`);
});

// POST /:id/publish — snapshot current draft as a new revision so workers
// can fill it in. Workers always see the latest published revision.
router.post('/:id/publish', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return res.redirect('/checklists'); }
  const items = db.prepare('SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC, id ASC').all(tpl.id);
  if (items.length === 0) { req.flash('error', 'Add at least one question before publishing.'); return res.redirect(`/checklists/${tpl.id}`); }

  const next = (db.prepare('SELECT MAX(revision_number) AS m FROM checklist_template_revisions WHERE template_id = ?').get(tpl.id).m || 0) + 1;
  db.prepare(`
    INSERT INTO checklist_template_revisions (template_id, revision_number, name, description, require_signature, require_photo, items_json, published_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tpl.id, next, tpl.name, tpl.description || '',
         tpl.require_signature ? 1 : 0, tpl.require_photo ? 1 : 0,
         JSON.stringify(items), req.session.user.id);
  db.prepare(`UPDATE checklist_templates SET published_revision = ?, published_at = datetime('now'), published_by_id = ? WHERE id = ?`)
    .run(next, req.session.user.id, tpl.id);

  logActivity({ user: req.session.user, action: 'publish', entityType: 'checklist_template', entityId: tpl.id, entityLabel: tpl.name, details: `Published revision ${next} (${items.length} questions)`, ip: req.ip });
  req.flash('success', `Revision ${next} published. Workers can now fill in the latest version.`);
  res.redirect(`/checklists/${tpl.id}`);
});

// POST /:id — Update template details
router.post('/:id', (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  db.prepare('UPDATE checklist_templates SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name || '', description || '', req.params.id);
  req.flash('success', 'Template updated.');
  res.redirect(`/checklists/${req.params.id}`);
});

// POST /:id/items — Add item
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const { question, response_type, section, required } = req.body;
  if (!question || !question.trim()) { req.flash('error', 'Question text is required.'); return res.redirect(`/checklists/${req.params.id}`); }

  const validTypes = ['yes_no_na', 'pass_fail', 'text', 'number', 'signature'];
  const rType = validTypes.includes(response_type) ? response_type : 'yes_no_na';

  // Get next order number
  const maxOrder = db.prepare('SELECT MAX(item_order) as mx FROM checklist_template_items WHERE template_id = ?').get(req.params.id);
  const nextOrder = (maxOrder && maxOrder.mx != null) ? maxOrder.mx + 1 : 0;

  db.prepare(`
    INSERT INTO checklist_template_items (template_id, item_order, section, question, response_type, required)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, nextOrder, section || '', question.trim(), rType, required ? 1 : 0);

  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', 'Question added.');
  res.redirect(`/checklists/${req.params.id}`);
});

// POST /:id/items/:itemId — Update item
router.post('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const { question, response_type, section, required } = req.body;

  db.prepare('UPDATE checklist_template_items SET question = ?, response_type = ?, section = ?, required = ? WHERE id = ? AND template_id = ?')
    .run(question || '', response_type || 'yes_no_na', section || '', required ? 1 : 0, req.params.itemId, req.params.id);

  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', 'Question updated.');
  res.redirect(`/checklists/${req.params.id}`);
});

// POST /:id/items/:itemId/delete — Remove item
router.post('/:id/items/:itemId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM checklist_template_items WHERE id = ? AND template_id = ?').run(req.params.itemId, req.params.id);
  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', 'Question removed.');
  res.redirect(`/checklists/${req.params.id}`);
});

// POST /:id/reorder — Reorder items (AJAX)
router.post('/:id/reorder', express.json(), (req, res) => {
  const db = getDb();
  const { order } = req.body; // array of item IDs in new order
  if (!Array.isArray(order)) return res.json({ success: false });

  const stmt = db.prepare('UPDATE checklist_template_items SET item_order = ? WHERE id = ? AND template_id = ?');
  order.forEach((itemId, idx) => { stmt.run(idx, itemId, req.params.id); });
  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /:id/archive — Toggle archive/active
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT status FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return res.redirect('/checklists'); }

  const newStatus = template.status === 'archived' ? 'active' : 'archived';
  db.prepare('UPDATE checklist_templates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
  req.flash('success', `Template ${newStatus === 'archived' ? 'archived' : 'reactivated'}.`);
  res.redirect('/checklists');
});

module.exports = router;
