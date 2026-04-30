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

  // Prefill start/finish from clock_events on this allocation if the worker
  // has clocked in (and out). Falls back to the rostered start/end times.
  // toLocaleTimeString in en-AU returns "HH:MM" once we ask for 2-digit
  // hours/minutes — exactly what the <input type="time"> field expects.
  const clockedIn = db.prepare(`
    SELECT event_time FROM clock_events
    WHERE crew_member_id = ? AND allocation_id = ? AND event_type = 'clock_in'
    ORDER BY event_time ASC LIMIT 1
  `).get(worker.id, allocation.id);
  const clockedOut = db.prepare(`
    SELECT event_time FROM clock_events
    WHERE crew_member_id = ? AND allocation_id = ? AND event_type = 'clock_out'
    ORDER BY event_time DESC LIMIT 1
  `).get(worker.id, allocation.id);
  const toHHMM = (utcStr) => {
    if (!utcStr) return '';
    const d = new Date(utcStr.includes('T') ? utcStr : utcStr.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
  };

  const prefillStart = toHHMM(clockedIn && clockedIn.event_time) || allocation.start_time || '';
  const prefillFinish = toHHMM(clockedOut && clockedOut.event_time) || allocation.end_time || '';

  // Sum any break_start/break_end pairs into prefilled break minutes.
  const breakEvents = db.prepare(`
    SELECT event_type, event_time FROM clock_events
    WHERE crew_member_id = ? AND allocation_id = ? AND event_type IN ('break_start','break_end')
    ORDER BY event_time ASC
  `).all(worker.id, allocation.id);
  let prefillBreakMinutes = 0;
  let openBreakStart = null;
  for (const ev of breakEvents) {
    if (ev.event_type === 'break_start') openBreakStart = new Date(ev.event_time);
    else if (ev.event_type === 'break_end' && openBreakStart) {
      prefillBreakMinutes += Math.max(0, Math.round((new Date(ev.event_time) - openBreakStart) / 60000));
      openBreakStart = null;
    }
  }
  if (!prefillBreakMinutes) prefillBreakMinutes = 30; // sensible default

  res.render('worker/docket-sign', {
    title: 'Sign Docket',
    currentPage: 'forms',
    allocation,
    prefillStart,
    prefillFinish,
    prefillBreakMinutes,
  });
});

// POST /w/dockets/sign/:allocationId — Submit signed docket
router.post('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const {
    docket_type, client_name, signature_data, client_signature, client_signed_name,
    notes, start_on_site, finish_on_site, break_minutes, travel_hours,
    no_client_on_site, no_client_reason
  } = req.body;
  // Checkbox: present in body when ticked. Treat anything truthy as yes.
  const noClient = no_client_on_site === '1' || no_client_on_site === 'on' || no_client_on_site === true;

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

  // When the worker flagged "no client on site", clear any client signature data
  // that might have been buffered on the form before the toggle was flipped, so
  // we don't store a half-captured client signature alongside the no-client flag.
  const finalClientSig = noClient ? null : (client_signature || null);
  const finalClientName = noClient ? null : (client_signed_name || null);
  const finalClientSignedAt = noClient ? null : (client_signature ? new Date().toISOString() : null);

  db.prepare(`
    INSERT INTO docket_signatures (
      allocation_id, crew_member_id, docket_type, client_name, signature_data,
      client_signature, client_signed_name, client_signed_at,
      notes, start_on_site, finish_on_site, break_minutes, travel_hours, total_hours,
      no_client_on_site, no_client_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    allocation.id,
    worker.id,
    docket_type || 'daily_docket',
    client_name || null,
    signature_data || null,
    finalClientSig,
    finalClientName,
    finalClientSignedAt,
    notes || null,
    start_on_site || null,
    finish_on_site || null,
    parseInt(break_minutes) || 0,
    parseFloat(travel_hours) || 0,
    totalHours,
    noClient ? 1 : 0,
    noClient ? (no_client_reason || '').trim() : ''
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
