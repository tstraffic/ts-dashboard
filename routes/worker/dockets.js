const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/dockets — My Dockets
router.get('/dockets', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Past dockets — LEFT JOIN jobs so booking-only allocations still show.
  // For those rows we COALESCE the booking title/number into client/job_number
  // so the UI doesn't render blanks.
  const dockets = db.prepare(`
    SELECT ds.*, ca.allocation_date, ca.job_id,
           COALESCE(j.job_number, b.booking_number) AS job_number,
           COALESCE(j.client, b.title) AS client
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ds.crew_member_id = ?
    ORDER BY ds.signed_at DESC LIMIT 30
  `).all(worker.id);

  const today = new Date().toISOString().split('T')[0];

  // Today's allocations (job-bound or booking-bound). LEFT JOIN jobs so a
  // booking-only allocation (job_id IS NULL) still surfaces, with COALESCE
  // pulling the booking's title / number / address / suburb in.
  const todaysShifts = db.prepare(`
    SELECT ca.id, ca.allocation_date, ca.start_time, ca.end_time, ca.status,
           ca.booking_id, ca.job_id,
           COALESCE(j.job_number, b.booking_number) AS job_number,
           COALESCE(j.client, b.title)             AS client,
           COALESCE(j.site_address, b.site_address) AS site_address,
           COALESCE(j.suburb, b.suburb)             AS suburb,
           'allocation' AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  // Booking-only fallback: workers assigned to a booking via booking_crew
  // who haven't yet hit /w/booking-shift/:id (which lazy-creates the alloc
  // row) won't have a crew_allocations row. Surface those here so they can
  // see "needs signing" — clicking the row routes to /w/booking-shift/...
  // which creates the alloc and then they can sign the docket from there.
  const VISIBLE_BOOKING_STATUSES = ['unconfirmed','confirmed','green_to_go','in_progress','completed','on_hold'];
  let bookingFallback = [];
  try {
    bookingFallback = db.prepare(`
      SELECT
        bc.id AS bc_id,
        bc.booking_id,
        b.booking_number AS job_number,
        b.title AS client,
        b.site_address, b.suburb,
        DATE(b.start_datetime) AS allocation_date,
        SUBSTR(b.start_datetime, 12, 5) AS start_time,
        SUBSTR(b.end_datetime, 12, 5) AS end_time,
        bc.status,
        'booking' AS source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) = ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
    `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* booking_crew may not exist on legacy DBs */ }

  const allTodayShifts = todaysShifts.concat(bookingFallback);

  // Which of today's allocations are already signed?
  const signedAllocIds = new Set(dockets.filter(d => d.allocation_date === today).map(d => d.allocation_id));
  const unsignedShifts = allTodayShifts.filter(s => s.source === 'booking' || !signedAllocIds.has(s.id));
  const signedShifts   = allTodayShifts.filter(s => s.source === 'allocation' && signedAllocIds.has(s.id));

  res.render('worker/dockets', {
    title: 'Dockets',
    currentPage: 'forms',
    dockets,
    todaysShifts: allTodayShifts,
    unsignedShifts,
    signedShifts,
    today,
  });
});

// GET /w/dockets/sign/:allocationId — Sign a docket
router.get('/dockets/sign/:allocationId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // LEFT JOIN both jobs and bookings — for booking-only allocations
  // (job_id IS NULL) we COALESCE the booking title/number/address into
  // the same fields the docket UI expects.
  const allocation = db.prepare(`
    SELECT ca.*,
           COALESCE(j.job_number, b.booking_number) AS job_number,
           COALESCE(j.job_name,   b.title)          AS job_name,
           COALESCE(j.client,     b.title)          AS client,
           COALESCE(j.site_address, b.site_address) AS site_address,
           COALESCE(j.suburb,     b.suburb)         AS suburb
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.allocationId, worker.id);

  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/dockets');
  }

  // T&S crews don't use clock in/out — the docket itself is the source of
  // truth for shift hours. Default prefill is the rostered start/end and a
  // sensible 30-minute break which the worker can edit.
  const prefillStart = allocation.start_time || '';
  const prefillFinish = allocation.end_time || '';
  const prefillBreakMinutes = 30;

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

  // Server-side enforcement of the same required fields the UI flags. We
  // can't trust the client alone — direct POSTs (or stale tabs) could skip
  // validation. Bounce the worker back with an error message if anything
  // mandatory is missing.
  const missing = [];
  if (!start_on_site)            missing.push('start time');
  if (!finish_on_site)           missing.push('finish time');
  if (!signature_data)           missing.push('your signature');
  if (!noClient && !client_signature) missing.push('client signature (or tick "no client on site")');
  if (missing.length) {
    req.flash('error', 'Missing: ' + missing.join(', ') + '.');
    return res.redirect('/w/dockets/sign/' + req.params.allocationId);
  }

  // Docket gating — two layers, matching the worker UI's split:
  //
  //   - REQUIRED: Risk Assessment & Toolbox + Team Leader Checklist must
  //     both be filed before the docket can be signed. These run for
  //     every shift regardless of role / vehicle.
  //   - RECOMMENDED: Vehicle Pre-Start, TC Prestart Declaration, Post-
  //     Shift Vehicle Checklist. Missing one of these triggers a
  //     warning and bounces the worker back to /w/jobs/:id?tab=forms.
  //     After two warnings the docket saves anyway so a stuck worker
  //     (e.g. no vehicle on shift) isn't permanently blocked. The
  //     session counter resets on a successful sign.
  const REQUIRED_TYPES = ['risk_toolbox','team_leader'];
  const RECOMMENDED_TYPES = ['vehicle_prestart','tc_prestart','post_shift_vehicle'];
  const ALL_TYPES = [...REQUIRED_TYPES, ...RECOMMENDED_TYPES];
  const FRIENDLY = {
    vehicle_prestart: 'Vehicle Pre-Start',
    risk_toolbox: 'Risk Assessment & Toolbox',
    tc_prestart: 'TC Prestart Declaration',
    team_leader: 'Team Leader Checklist',
    post_shift_vehicle: 'Post-Shift Vehicle Checklist',
  };
  const submittedTypes = db.prepare(`
    SELECT DISTINCT form_type FROM safety_forms
    WHERE crew_member_id = ? AND allocation_id = ? AND form_type IN (${ALL_TYPES.map(() => '?').join(',')})
  `).all(worker.id, allocation.id, ...ALL_TYPES).map(r => r.form_type);

  const missingRequired = REQUIRED_TYPES.filter(t => !submittedTypes.includes(t));
  if (missingRequired.length) {
    req.flash('error',
      'You can\'t sign the docket yet — these are required first: ' +
      missingRequired.map(m => FRIENDLY[m]).join(', ') + '.');
    return res.redirect('/w/jobs/' + allocation.id + '?tab=forms');
  }

  const missingRecommended = RECOMMENDED_TYPES.filter(t => !submittedTypes.includes(t));
  if (missingRecommended.length) {
    req.session.docketWarnings = req.session.docketWarnings || {};
    const key = String(allocation.id);
    const seen = req.session.docketWarnings[key] || 0;
    if (seen < 2) {
      req.session.docketWarnings[key] = seen + 1;
      const left = 2 - seen;
      req.flash('error',
        'Heads up — these recommended checklists are missing: ' +
        missingRecommended.map(m => FRIENDLY[m]).join(', ') + '. ' +
        (left === 1
          ? 'Tap "Sign & Submit" once more and the docket will save anyway.'
          : `Tap "Sign & Submit" ${left} more times to confirm you don\'t need them, or fill them in now.`));
      return res.redirect('/w/jobs/' + allocation.id + '?tab=forms');
    }
    console.warn('[dockets] forced-through with missing recommended', {
      worker: worker.id, allocation: allocation.id, missing: missingRecommended,
    });
  }
  if (req.session.docketWarnings) delete req.session.docketWarnings[String(allocation.id)];

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
