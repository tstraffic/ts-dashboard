const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../lib/activity');

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

  res.render('checklists/show', {
    title: `Template: ${template.name}`,
    currentPage: 'checklists',
    template,
    items,
    user: req.session.user
  });
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
