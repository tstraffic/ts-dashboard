const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../../db/database');

// GET /w/login — Show worker login form
router.get('/login', (req, res) => {
  // If already logged in as worker, redirect to home
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

  // Look up crew member by employee_id
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

  // Verify PIN
  const pinMatch = bcrypt.compareSync(pin, member.pin_hash);
  if (!pinMatch) {
    req.flash('error', 'Invalid Employee ID or PIN.');
    return res.redirect('/w/login');
  }

  // Set worker session
  req.session.worker = {
    id: member.id,
    full_name: member.full_name,
    employee_id: member.employee_id,
    role: member.role,
    phone: member.phone,
    email: member.email,
  };

  // Update login stats
  db.prepare(`
    UPDATE crew_members SET last_worker_login = CURRENT_TIMESTAMP, worker_login_count = COALESCE(worker_login_count, 0) + 1 WHERE id = ?
  `).run(member.id);

  // Redirect to stored return URL or home
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

module.exports = router;
