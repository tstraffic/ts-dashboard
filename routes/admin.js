const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { adminInviteEmail } = require('../services/emailTemplates');
const { logActivity } = require('../middleware/audit');

// Only management can access admin
router.use(requireRole('management'));

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, password_hash, full_name, email, role, active, created_at FROM users ORDER BY full_name').all();
  res.render('admin/users', { title: 'User Management', users, user: req.session.user });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { title: 'Add User', editUser: null, user: req.session.user });
});

router.post('/users', async (req, res) => {
  const db = getDb();
  const b = req.body;
  const sendInvite = [].concat(b.send_invite).pop() === '1' && b.email;

  try {
    if (sendInvite) {
      if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        req.flash('error', 'Email invitations require SMTP to be configured. Create the user with a password instead, or set up SMTP in Railway environment variables.');
        return res.redirect('/admin/users/new');
      }
      const result = db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
        b.username, 'INVITE_PENDING', b.full_name, b.email, b.role, 0
      );
      const userId = result.lastInsertRowid;
      const { token } = createInvitation({ type: 'admin_user', targetId: userId, email: b.email, createdById: req.session.user.id });
      const inviteUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/invite/' + token;
      const emailResult = await sendEmail(b.email, 'You\'ve been invited to T&S Operations Dashboard', adminInviteEmail(b.full_name, inviteUrl, TOKEN_EXPIRY_HOURS));
      logActivity({ user: req.session.user, action: 'create', entityType: 'user', entityId: userId, entityLabel: b.full_name, details: 'Created user via email invitation', ip: req.ip });
      if (emailResult) {
        req.flash('success', `Invitation sent to ${b.email} for ${b.username}.`);
      } else {
        req.flash('success', `User ${b.username} created but email failed to send. Use "Resend Invite" from the user list once SMTP is configured.`);
      }
    } else {
      if (!b.password) {
        req.flash('error', 'Password is required when not sending an invite.');
        return res.redirect('/admin/users/new');
      }
      const hash = bcrypt.hashSync(b.password, 12);
      db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
        b.username, hash, b.full_name, b.email || '', b.role, b.active ? 1 : 0
      );
      req.flash('success', `User ${b.username} created.`);
    }
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

// DELETE USER
router.post('/users/:id/delete', (req, res) => {
  const db = getDb();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }

  // Prevent deleting yourself
  if (targetUser.id === req.session.user.id) {
    req.flash('error', 'You cannot delete your own account.');
    return res.redirect('/admin/users');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.full_name, details: 'Deleted user account', ip: req.ip });
  req.flash('success', `User ${targetUser.username} deleted.`);
  res.redirect('/admin/users');
});

// Resend invitation email
router.post('/users/:id/resend-invite', async (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || u.password_hash !== 'INVITE_PENDING' || !u.email) {
    req.flash('error', 'No pending invitation for this user.');
    return res.redirect('/admin/users');
  }
  const { token } = createInvitation({ type: 'admin_user', targetId: u.id, email: u.email, createdById: req.session.user.id });
  const inviteUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/invite/' + token;
  await sendEmail(u.email, 'You\'ve been invited to T&S Operations Dashboard', adminInviteEmail(u.full_name, inviteUrl, TOKEN_EXPIRY_HOURS));
  req.flash('success', `Invitation resent to ${u.email}.`);
  res.redirect('/admin/users');
});

module.exports = router;
