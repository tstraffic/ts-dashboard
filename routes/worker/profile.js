const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const bcrypt = require('bcryptjs');

// GET /w/profile — Worker profile
router.get('/profile', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);

  res.render('worker/profile', {
    title: 'My Profile',
    currentPage: 'more',
    member,
  });
});

// POST /w/profile — Update contact info
router.post('/profile', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { phone, email } = req.body;

  db.prepare('UPDATE crew_members SET phone = ?, email = ? WHERE id = ?').run(phone || null, email || null, worker.id);

  // Update session
  req.session.worker.phone = phone || null;
  req.session.worker.email = email || null;

  req.flash('success', 'Profile updated.');
  res.redirect('/w/profile');
});

// POST /w/profile/pin — Change PIN
router.post('/profile/pin', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { current_pin, new_pin, confirm_pin } = req.body;

  if (!current_pin || !new_pin || !confirm_pin) {
    req.flash('error', 'All PIN fields are required.');
    return res.redirect('/w/profile');
  }

  if (new_pin !== confirm_pin) {
    req.flash('error', 'New PINs do not match.');
    return res.redirect('/w/profile');
  }

  if (!/^\d{4,6}$/.test(new_pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect('/w/profile');
  }

  const member = db.prepare('SELECT pin_hash FROM crew_members WHERE id = ?').get(worker.id);
  if (!member || !bcrypt.compareSync(current_pin, member.pin_hash)) {
    req.flash('error', 'Current PIN is incorrect.');
    return res.redirect('/w/profile');
  }

  const newHash = bcrypt.hashSync(new_pin, 12);
  db.prepare('UPDATE crew_members SET pin_hash = ?, pin_set_at = datetime(\'now\') WHERE id = ?').run(newHash, worker.id);

  req.flash('success', 'PIN changed successfully.');
  res.redirect('/w/profile');
});

module.exports = router;
