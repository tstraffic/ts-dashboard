const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/dockets — My Dockets
router.get('/dockets', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const dockets = db.prepare(`
    SELECT ds.*, ca.allocation_date, ca.job_id, j.job_number, j.client
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ds.crew_member_id = ?
    ORDER BY ds.signed_at DESC LIMIT 30
  `).all(worker.id);

  // Get today's allocations that might need dockets
  const today = new Date().toISOString().split('T')[0];
  const todaysShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.client
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  res.render('worker/dockets', {
    title: 'Dockets',
    currentPage: 'more',
    dockets,
    todaysShifts,
    today,
  });
});

// GET /w/dockets/sign/:allocationId — Sign a docket
router.get('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.allocationId, worker.id);

  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/dockets');
  }

  res.render('worker/docket-sign', {
    title: 'Sign Docket',
    currentPage: 'more',
    allocation,
  });
});

// POST /w/dockets/sign/:allocationId — Submit signed docket
router.post('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { docket_type, client_name, signature_data, notes } = req.body;

  const allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(req.params.allocationId, worker.id);
  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/dockets');
  }

  db.prepare(`
    INSERT INTO docket_signatures (allocation_id, crew_member_id, docket_type, client_name, signature_data, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(allocation.id, worker.id, docket_type || 'daily_docket', client_name || null, signature_data || null, notes || null);

  req.flash('success', 'Docket signed successfully.');
  res.redirect('/w/dockets');
});

module.exports = router;
