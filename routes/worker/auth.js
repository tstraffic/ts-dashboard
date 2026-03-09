const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../../db/database');
const { createInvitation, validateToken, markTokenUsed, TOKEN_EXPIRY_HOURS } = require('../../services/invitations');
const { sendEmail } = require('../../services/email');
const { pinResetEmail } = require('../../services/emailTemplates');

// GET /w/login — Show worker login form
router.get('/login', (req, res) => {
  if (req.session && req.session.worker) {
    return res.redirect('/w/home');
  }
  res.render('worker/login', {
    layout: false,
    title: 'Sign In',
    flash_error: req.flash('error'),
    flash_success: req.flash('success'),
  });
});

// POST /w/login — Authenticate worker
router.post('/login', (req, res) => {
  const { employee_id, pin } = req.body;

  if (!employee_id || !pin) {
    req.flash('error', 'Please enter your Employee ID and PIN.');
    return res.redirect('/w/login');
  }

  const db = getDb();
  const member = db.prepare(
    'SELECT id, full_name, employee_id, role, phone, email, pin_hash, active FROM crew_members WHERE employee_id = ?'
  ).get(employee_id.trim());

  if (!member) {
    req.flash('error', 'Invalid Employee ID or PIN.');
    return res.redirect('/w/login');
  }

  if (!member.active) {
    req.flash('error', 'Your account is inactive. Please contact your supervisor.');
    return res.redirect('/w/login');
  }

  if (!member.pin_hash) {
    req.flash('error', 'No portal PIN has been set for your account. Please contact your supervisor.');
    return res.redirect('/w/login');
  }

  const pinMatch = bcrypt.compareSync(pin, member.pin_hash);
  if (!pinMatch) {
    req.flash('error', 'Invalid Employee ID or PIN.');
    return res.redirect('/w/login');
  }

  req.session.worker = {
    id: member.id,
    full_name: member.full_name,
    employee_id: member.employee_id,
    role: member.role,
    phone: member.phone,
    email: member.email,
  };

  db.prepare(`
    UPDATE crew_members SET last_worker_login = CURRENT_TIMESTAMP, worker_login_count = COALESCE(worker_login_count, 0) + 1 WHERE id = ?
  `).run(member.id);

  const returnTo = req.session.workerReturnTo || '/w/home';
  delete req.session.workerReturnTo;
  res.redirect(returnTo);
});

// GET /w/logout — Sign out worker
router.get('/logout', (req, res) => {
  delete req.session.worker;
  delete req.session.workerReturnTo;
  req.flash('success', 'You have been signed out.');
  res.redirect('/w/login');
});

// Forgot PIN
router.get('/forgot-pin', (req, res) => {
  res.render('worker/forgot-pin', {
    layout: false,
    title: 'Forgot PIN',
    flash_error: req.flash('error'),
    flash_success: req.flash('success'),
  });
});

router.post('/forgot-pin', async (req, res) => {
  const { employee_id, email } = req.body;
  const db = getDb();
  const member = db.prepare('SELECT id, full_name, email FROM crew_members WHERE employee_id = ? AND email = ? AND active = 1').get(employee_id, email);

  if (member && member.email) {
    const { token } = createInvitation({ type: 'pin_reset', targetId: member.id, email: member.email, createdById: null });
    const resetUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/w/reset-pin/' + token;
    await sendEmail(member.email, 'Reset your T&S Worker Portal PIN', pinResetEmail(member.full_name, resetUrl, TOKEN_EXPIRY_HOURS));
  }

  req.flash('success', 'If a matching account exists, a reset link has been sent to your email.');
  res.redirect('/w/forgot-pin');
});

// Reset PIN via token
router.get('/reset-pin/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'pin_reset');
  if (!invitation) {
    return res.render('worker/reset-pin', {
      layout: false,
      title: 'Invalid Link',
      error: 'This reset link is invalid or has expired.',
      token: null,
      flash_error: [],
    });
  }
  res.render('worker/reset-pin', {
    layout: false,
    title: 'Reset PIN',
    error: null,
    token: req.params.token,
    flash_error: req.flash('error'),
  });
});

router.post('/reset-pin/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'pin_reset');
  if (!invitation) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return res.redirect('/w/forgot-pin');
  }

  const { pin, pin_confirm } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect('/w/reset-pin/' + req.params.token);
  }
  if (pin !== pin_confirm) {
    req.flash('error', 'PINs do not match.');
    return res.redirect('/w/reset-pin/' + req.params.token);
  }

  const db = getDb();
  const pinHash = bcrypt.hashSync(pin, 12);
  db.prepare('UPDATE crew_members SET pin_hash = ?, pin_set_at = CURRENT_TIMESTAMP WHERE id = ?').run(pinHash, invitation.target_id);
  markTokenUsed(req.params.token);

  req.flash('success', 'Your PIN has been reset. You can now sign in.');
  res.redirect('/w/login');
});

module.exports = router;
