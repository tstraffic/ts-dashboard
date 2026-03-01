const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole('management'), (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  // Build filter query
  let where = [];
  let params = [];

  if (req.query.user_id) {
    where.push('al.user_id = ?');
    params.push(req.query.user_id);
  }
  if (req.query.action) {
    where.push('al.action = ?');
    params.push(req.query.action);
  }
  if (req.query.entity_type) {
    where.push('al.entity_type = ?');
    params.push(req.query.entity_type);
  }
  if (req.query.job_id) {
    where.push('al.job_id = ?');
    params.push(req.query.job_id);
  }
  if (req.query.from_date) {
    where.push('al.created_at >= ?');
    params.push(req.query.from_date);
  }
  if (req.query.to_date) {
    where.push('al.created_at <= ? || " 23:59:59"');
    params.push(req.query.to_date);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM activity_log al ${whereClause}`).get(...params).count;
  const totalPages = Math.ceil(total / limit);

  const logs = db.prepare(`
    SELECT al.*, u.full_name as user_display_name
    FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    ${whereClause}
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  // Get users and jobs for filter dropdowns
  const users = db.prepare('SELECT id, full_name FROM users ORDER BY full_name').all();
  const jobs = db.prepare("SELECT id, job_number FROM jobs ORDER BY job_number DESC").all();

  res.render('activity/index', {
    title: 'Activity Log',
    currentPage: 'activity',
    logs,
    users,
    jobs,
    filters: req.query,
    pagination: { page, totalPages, total }
  });
});

module.exports = router;
