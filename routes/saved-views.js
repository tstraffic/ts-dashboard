const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/views?module=jobs — list saved views for current user
router.get('/', (req, res) => {
  const db = getDb();
  const { module } = req.query;
  if (!module) return res.json([]);

  const views = db.prepare(
    'SELECT id, name, query_params, is_default FROM saved_views WHERE user_id = ? AND module = ? ORDER BY is_default DESC, name ASC'
  ).all(req.session.user.id, module);

  res.json(views);
});

// POST /api/views — save a new view
router.post('/', (req, res) => {
  const db = getDb();
  const { module, name, query_params } = req.body;

  if (!module || !name) return res.status(400).json({ error: 'Module and name required' });

  const existing = db.prepare('SELECT COUNT(*) as c FROM saved_views WHERE user_id = ? AND module = ?').get(req.session.user.id, module).c;
  if (existing >= 10) return res.status(400).json({ error: 'Maximum 10 saved views per module' });

  const result = db.prepare(
    'INSERT INTO saved_views (user_id, module, name, query_params) VALUES (?, ?, ?, ?)'
  ).run(req.session.user.id, module, name.substring(0, 50), query_params || '');

  res.json({ id: result.lastInsertRowid, name, query_params });
});

// DELETE /api/views/:id — delete a saved view
router.delete('/:id', (req, res) => {
  const db = getDb();
  const view = db.prepare('SELECT * FROM saved_views WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (!view) return res.status(404).json({ error: 'View not found' });

  db.prepare('DELETE FROM saved_views WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
