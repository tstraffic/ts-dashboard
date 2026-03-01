const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login', user: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    role: user.role
  };

  const returnTo = req.session.returnTo || '/dashboard';
  delete req.session.returnTo;
  res.redirect(returnTo);
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
