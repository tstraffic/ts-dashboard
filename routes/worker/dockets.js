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
    SELECT ca.*, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  // Check which of today's shifts already have dockets
  const signedAllocIds = new Set(dockets.filter(d => d.allocation_date === today).map(d => d.allocation_id));
  const unsignedShifts = todaysShifts.filter(s => !signedAllocIds.has(s.id));
  const signedShifts = todaysShifts.filter(s => signedAllocIds.has(s.id));

  res.render('worker/dockets', {
    title: 'Dockets',
    currentPage: 'forms',
    dockets,
    todaysShifts,
    unsignedShifts,
    signedShifts,
    today,
  });
});

// GET /w/dockets/sign/:allocationId — Sign a docket
router.get('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb
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
    currentPage: 'forms',
    allocation,
  });
});

// POST /w/dockets/sign/:allocationId — Submit signed docket
router.post('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const {
    docket_type, client_name, signature_data, client_signature, client_signed_name,
    notes, start_on_site, finish_on_site, break_minutes, travel_hours
  } = req.body;

  const allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(req.params.allocationId, worker.id);
  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/dockets');
  }

  // Calculate total hours
  let totalHours = 0;
  if (start_on_site && finish_on_site) {
    const [sh, sm] = start_on_site.split(':').map(Number);
    const [fh, fm] = finish_on_site.split(':').map(Number);
    const startMin = sh * 60 + sm;
    const finishMin = fh * 60 + fm;
    const workedMin = finishMin > startMin ? finishMin - startMin : (1440 - startMin) + finishMin;
    const breakMin = parseInt(break_minutes) || 0;
    totalHours = Math.max(0, (workedMin - breakMin) / 60);
    totalHours = Math.round(totalHours * 100) / 100;
  }

  db.prepare(`
    INSERT INTO docket_signatures (
      allocation_id, crew_member_id, docket_type, client_name, signature_data,
      client_signature, client_signed_name, client_signed_at,
      notes, start_on_site, finish_on_site, break_minutes, travel_hours, total_hours
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    allocation.id,
    worker.id,
    docket_type || 'daily_docket',
    client_name || null,
    signature_data || null,
    client_signature || null,
    client_signed_name || null,
    client_signature ? new Date().toISOString() : null,
    notes || null,
    start_on_site || null,
    finish_on_site || null,
    parseInt(break_minutes) || 0,
    parseFloat(travel_hours) || 0,
    totalHours
  );

  req.flash('success', 'Docket signed successfully.');

  // Redirect back to job detail docket tab if came from there
  const referer = req.get('Referer') || '';
  if (referer.includes('/w/jobs/')) {
    return res.redirect('/w/jobs/' + allocation.id + '?tab=docket');
  }
  res.redirect('/w/dockets');
});

module.exports = router;
