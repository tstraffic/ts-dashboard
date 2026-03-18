const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /bookings — Board view (default)
router.get('/', (req, res) => {
  const view = req.query.view || 'board';
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  const depot = req.query.depot || '';
  const status = req.query.status || '';
  const search = req.query.search || '';

  // TODO: Replace with real bookings DB queries once bookings table is created
  const bookings = [];

  const stats = {
    total: 0,
    completed: 0,
    greenToGo: 0,
    confirmed: 0,
    unconfirmed: 0,
    inProgress: 0,
    cancelled: 0,
  };

  const depots = ['Villawood', 'Penrith', 'Campbelltown', 'Parramatta'];

  res.render('bookings/index', {
    title: 'Bookings Board',
    bookings,
    stats,
    depots,
    currentView: view,
    currentDate: dateStr,
    currentDepot: depot,
    currentStatus: status,
    currentSearch: search,
    user: req.session.user,
  });
});

// GET /bookings/:id — Booking detail (JSON for modal)
router.get('/:id', (req, res) => {
  // TODO: Replace with real booking DB lookup once bookings table is created
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  req.flash('error', 'Booking not found');
  return res.redirect('/bookings');
});

module.exports = router;
