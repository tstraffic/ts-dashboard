const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// ============================================
// LIST NOTIFICATIONS FOR CURRENT USER
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  const notifications = db.prepare(`
    SELECT n.*, j.job_number
    FROM notifications n
    LEFT JOIN jobs j ON n.job_id = j.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 100
  `).all(userId);

  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).count;

  res.render('notifications/index', {
    title: 'Notifications',
    currentPage: 'notifications',
    notifications,
    unreadCount
  });
});

// ============================================
// MARK SINGLE NOTIFICATION AS READ
// ============================================
router.post('/:id/read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  // If there is a link, redirect there
  const notif = db.prepare('SELECT link FROM notifications WHERE id = ?').get(req.params.id);
  if (notif && notif.link) return res.redirect(notif.link);
  res.redirect('/notifications');
});

// ============================================
// MARK ALL AS READ
// ============================================
router.post('/mark-all-read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.session.user.id);
  req.flash('success', 'All notifications marked as read.');
  res.redirect('/notifications');
});

// ============================================
// CLEAR OLD NOTIFICATIONS (30+ days)
// ============================================
router.post('/clear-old', (req, res) => {
  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').run(req.session.user.id, thirtyDaysAgo);
  req.flash('success', 'Old notifications cleared.');
  res.redirect('/notifications');
});

module.exports = router;
