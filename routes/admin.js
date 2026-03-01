const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');

// Only management can access admin
router.use(requireRole('management'));

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, full_name, email, role, active, created_at FROM users ORDER BY full_name').all();
  res.render('admin/users', { title: 'User Management', users, user: req.session.user });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { title: 'Add User', editUser: null, user: req.session.user });
});

router.post('/users', (req, res) => {
  const db = getDb();
  const b = req.body;
  const hash = bcrypt.hashSync(b.password, 12);
  try {
    db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
      b.username, hash, b.full_name, b.email || '', b.role, b.active ? 1 : 0
    );
    req.flash('success', `User ${b.username} created.`);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Username "${b.username}" already exists.`);
    } else {
      req.flash('error', 'Failed to create user: ' + err.message);
    }
  }
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', (req, res) => {
  const db = getDb();
  const editUser = db.prepare('SELECT id, username, full_name, email, role, active FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }
  res.render('admin/user-form', { title: 'Edit User', editUser, user: req.session.user });
});

router.post('/users/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  if (b.password) {
    const hash = bcrypt.hashSync(b.password, 12);
    db.prepare('UPDATE users SET full_name=?, email=?, role=?, active=?, password_hash=? WHERE id=?').run(
      b.full_name, b.email || '', b.role, b.active ? 1 : 0, hash, req.params.id
    );
  } else {
    db.prepare('UPDATE users SET full_name=?, email=?, role=?, active=? WHERE id=?').run(
      b.full_name, b.email || '', b.role, b.active ? 1 : 0, req.params.id
    );
  }
  req.flash('success', 'User updated.');
  res.redirect('/admin/users');
});

module.exports = router;
