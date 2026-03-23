const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { autoAddUserToChannels } = require('../lib/chat');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail, isConfigured } = require('../services/email');
const { adminInviteEmail } = require('../services/emailTemplates');
const { logActivity } = require('../middleware/audit');

// Only admin can access admin panel
router.use(requireRole('admin'));

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, password_hash, full_name, email, role, active, created_at FROM users ORDER BY full_name').all();

  // Stats
  const roleAliases = { management: 'admin', accounts: 'finance', marketing: 'operations' };
  const stats = {
    total: users.length,
    active: users.filter(u => u.active && u.password_hash !== 'INVITE_PENDING').length,
    pending: users.filter(u => u.password_hash === 'INVITE_PENDING').length,
    inactive: users.filter(u => !u.active && u.password_hash !== 'INVITE_PENDING').length,
    byRole: {}
  };
  users.forEach(u => {
    const r = roleAliases[u.role] || u.role || 'unknown';
    stats.byRole[r] = (stats.byRole[r] || 0) + 1;
  });

  res.render('admin/users', { title: 'User Management', users, user: req.session.user, stats });
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
      if (!isConfigured()) {
        req.flash('error', 'Email invitations require SMTP to be configured. Go to Settings → System Configuration to set up SMTP, or add SMTP environment variables in Railway.');
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
      autoAddUserToChannels(Number(userId), b.role);
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
      const directResult = db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
        b.username, hash, b.full_name, b.email || '', b.role, b.active ? 1 : 0
      );
      autoAddUserToChannels(Number(directResult.lastInsertRowid), b.role);
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

  try {
    // Nullify foreign key references so delete doesn't fail
    const refTables = [
      { table: 'jobs', cols: ['project_manager_id', 'ops_supervisor_id', 'planning_owner_id', 'marketing_owner_id', 'accounts_owner_id', 'traffic_supervisor_id'] },
      { table: 'tasks', cols: ['owner_id'] },
      { table: 'timesheets', cols: ['approved_by_id'] },
      { table: 'activity_log', cols: ['user_id'] },
      { table: 'compliance', cols: ['internal_approver_id', 'assigned_to_id'] },
      { table: 'communication_log', cols: ['logged_by_id'] },
      { table: 'equipment_assignments', cols: ['assigned_by_id'] },
      { table: 'invitations', cols: ['created_by_id'] },
    ];
    for (const ref of refTables) {
      for (const col of ref.cols) {
        try { db.prepare(`UPDATE ${ref.table} SET ${col} = NULL WHERE ${col} = ?`).run(req.params.id); } catch (e) { /* table/col may not exist */ }
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.full_name, details: 'Deleted user account', ip: req.ip });
    req.flash('success', `User ${targetUser.username} deleted.`);
  } catch (err) {
    req.flash('error', `Failed to delete user: ${err.message}`);
  }
  res.redirect('/admin/users');
});

// Reset password
router.post('/users/:id/reset-password', (req, res) => {
  const db = getDb();
  const targetUser = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }

  const newPassword = req.body.new_password;
  if (!newPassword || newPassword.length < 6) {
    req.flash('error', 'Password must be at least 6 characters.');
    return res.redirect('/admin/users');
  }

  try {
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.full_name, details: 'Reset password', ip: req.ip });
    req.flash('success', `Password reset for ${targetUser.username}.`);
  } catch (err) {
    req.flash('error', 'Failed to reset password: ' + err.message);
  }
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
