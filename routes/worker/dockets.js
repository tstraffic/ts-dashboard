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

  // Soft gate: T&S crews don't clock in/out — proof of attendance is the
  // pre-start toolbox + the docket itself. The rule the office wants:
  //
  //   - Allow the docket as soon as the worker has filed a MAJORITY of the
  //     five Job-Pack checklists for this shift (3+ of 5).
  //   - Below that, warn the worker and bounce them back to Forms. After
  //     two warnings, let them through so a stuck worker can still close
  //     out the day. The session counter resets on a successful sign so
  //     accidentally-warned workers don't get locked out next time.
  const JOB_PACK_TYPES = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];
  const submittedTypes = db.prepare(`
    SELECT DISTINCT form_type FROM safety_forms
    WHERE crew_member_id = ? AND allocation_id = ? AND form_type IN (${JOB_PACK_TYPES.map(() => '?').join(',')})
  `).all(worker.id, allocation.id, ...JOB_PACK_TYPES).map(r => r.form_type);
  const missingTypes = JOB_PACK_TYPES.filter(t => !submittedTypes.includes(t));
  const FRIENDLY = {
    vehicle_prestart: 'Vehicle Pre-Start',
    risk_toolbox: 'Risk Assessment & Toolbox',
    tc_prestart: 'TC Prestart Declaration',
    team_leader: 'Team Leader Checklist',
    post_shift_vehicle: 'Post-Shift Vehicle Checklist',
  };
  const majority = submittedTypes.length >= 3;

  if (!majority) {
    req.session.docketWarnings = req.session.docketWarnings || {};
    const key = String(allocation.id);
    const seen = req.session.docketWarnings[key] || 0;
    if (seen < 2) {
      req.session.docketWarnings[key] = seen + 1;
      const missingList = missingTypes.map(m => FRIENDLY[m]).slice(0, 3).join(', ');
      const left = 2 - seen; // attempts remaining before we let them through
      req.flash('error',
        `You’ve only completed ${submittedTypes.length} of 5 Job-Pack checklists. Missing: ${missingList}. ` +
        `${left === 1 ? 'One more attempt and the docket will save anyway, but please complete the outstanding checklists.' : `You can save the docket after ${left} more confirmations, but please complete the outstanding checklists first.`}`);
      return res.redirect('/w/jobs/' + allocation.id + '?tab=forms');
    }
    // Third try: let the docket through but log the override so admins can
    // see who's been bypassing the gate.
    console.warn('[dockets] forced-through under-majority docket', { worker: worker.id, allocation: allocation.id, submitted: submittedTypes, missing: missingTypes });
  }
  // Reset the warning counter once the docket actually saves.
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
