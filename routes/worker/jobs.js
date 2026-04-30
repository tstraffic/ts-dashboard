const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/shifts — Alias, redirect to /w/jobs (preserving query params)
router.get('/shifts', (req, res) => {
  const qs = req.originalUrl.split('?')[1];
  res.redirect('/w/jobs' + (qs ? '?' + qs : ''));
});

// GET /w/shifts/:id — Alias, redirect to /w/jobs/:id
router.get('/shifts/:id', (req, res) => {
  res.redirect('/w/jobs/' + req.params.id);
});

// GET /w/jobs — My Shifts (all upcoming + finished)
router.get('/jobs', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];
  const tab = req.query.tab || 'upcoming';

  // The bookings table CHECK uses these literal status values:
  //   'unconfirmed','confirmed','green_to_go','in_progress','completed',
  //   'cancelled','late_cancellation','on_hold'
  // Worker-visible bookings = anything that's not cancelled / late-cancelled.
  // Including 'unconfirmed' so a newly-assigned shift surfaces as a Pending
  // request the worker can accept/decline before the allocator confirms.
  const VISIBLE_BOOKING_STATUSES = ['unconfirmed','confirmed','green_to_go','in_progress','completed','on_hold'];

  // Upcoming from crew_allocations (job-linked shifts)
  // Exclude allocations linked to cancelled/deleted bookings.
  const allocUpcoming = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb,
      j.notes as job_notes, j.project_name, j.client_project_number, j.state,
      u.full_name as supervisor_name, 'allocation' as source
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date >= ?
      AND ca.status IN ('allocated', 'confirmed')
      AND (ca.booking_id IS NULL OR (
        b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND b.deleted_at IS NULL))
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);

  // Upcoming from booking_crew (bookings without job allocations — fallback)
  let bookingUpcoming = [];
  try {
    bookingUpcoming = db.prepare(`
      SELECT bc.id, bc.booking_id, bc.status, bc.role_on_site,
        b.booking_number as job_number, b.title as job_name, b.title as client,
        b.site_address, b.suburb, b.notes as job_notes, b.title as project_name,
        '' as client_project_number, b.state,
        DATE(b.start_datetime) as allocation_date,
        SUBSTR(b.start_datetime, 12, 5) as start_time,
        SUBSTR(b.end_datetime, 12, 5) as end_time,
        '' as supervisor_name, 'booking' as source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) >= ?
        AND bc.status IN ('assigned', 'confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC
    `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* booking_crew may not have matching columns */ }

  // Merge and deduplicate
  const upcoming = [...allocUpcoming, ...bookingUpcoming.map(b => ({
    ...b, status: b.status === 'assigned' ? 'allocated' : b.status
  }))].sort((a, b) => (a.allocation_date + a.start_time).localeCompare(b.allocation_date + b.start_time));

  // Split upcoming into requests (allocated) and confirmed
  const requests = upcoming.filter(a => a.status === 'allocated');
  const confirmed = upcoming.filter(a => a.status === 'confirmed');

  // Finished from crew_allocations
  const finished = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb,
      j.notes as job_notes, j.project_name, j.client_project_number, j.state,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ?
      AND ca.status != 'cancelled'
      AND (ca.status IN ('completed', 'declined') OR ca.allocation_date < ?)
    ORDER BY ca.allocation_date DESC, ca.start_time DESC
    LIMIT 20
  `).all(worker.id, today);

  // Helper: group allocations by date
  function groupByDate(list) {
    const groups = {};
    list.forEach(a => {
      if (!groups[a.allocation_date]) groups[a.allocation_date] = [];
      groups[a.allocation_date].push(a);
    });
    return groups;
  }

  res.render('worker/jobs', {
    title: 'My Shifts',
    currentPage: 'shifts',
    tab,
    today,
    requests,
    confirmed,
    finished,
    requestsByDate: groupByDate(requests),
    confirmedByDate: groupByDate(confirmed),
    finishedByDate: groupByDate(finished),
  });
});

// GET /w/jobs/:id — Job detail (allocation detail)
router.get('/jobs/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const tab = req.query.tab || 'info';

  // Get this allocation (must belong to this worker)
  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb,
      j.status as job_status, j.notes as job_notes,
      j.start_date as job_start, j.end_date as job_end,
      j.project_name, j.client_project_number, j.state, j.crew_size,
      u.full_name as supervisor_name, u.email as supervisor_email
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Job not found or you do not have access.');
    return res.redirect('/w/jobs');
  }

  // Get other crew on the same job & date
  const otherCrew = db.prepare(`
    SELECT ca.role_on_site, ca.shift_type, ca.start_time, ca.end_time, ca.status,
      cm.full_name, cm.phone, cm.role as crew_role
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.crew_member_id != ? AND ca.status != 'cancelled'
    ORDER BY cm.full_name ASC
  `).all(allocation.job_id, allocation.allocation_date, worker.id);

  // Get supervisor phone
  let supervisorPhone = '';
  if (allocation.supervisor_name) {
    const supCrew = db.prepare("SELECT phone FROM crew_members WHERE full_name = ? AND phone != ''").get(allocation.supervisor_name);
    if (supCrew) supervisorPhone = supCrew.phone;
  }

  // Get safety forms for this allocation
  const forms = db.prepare(`
    SELECT id, form_type, status, submitted_at, created_at
    FROM safety_forms
    WHERE crew_member_id = ? AND allocation_id = ?
    ORDER BY created_at DESC
  `).all(worker.id, allocation.id);

  // Also check for forms linked by job_id on same date (some may not have allocation_id)
  const formsByJob = db.prepare(`
    SELECT id, form_type, status, submitted_at, created_at
    FROM safety_forms
    WHERE crew_member_id = ? AND job_id = ? AND allocation_id IS NULL
      AND date(created_at) = ?
    ORDER BY created_at DESC
  `).all(worker.id, allocation.job_id, allocation.allocation_date);

  const allForms = [...forms, ...formsByJob];

  // Build form completion status — legacy forms + the five Traffio Job-Pack
  // checklists. allForms already contains every safety_forms row this worker
  // has filed against this allocation (or against the same job/date when no
  // allocation_id was set), so a simple .find() per form_type tells us if it's
  // done. The detail page uses these flags to show emerald check vs amber pill.
  const formStatus = {
    prestart: allForms.find(f => f.form_type === 'prestart') || null,
    take5: allForms.find(f => f.form_type === 'take5') || null,
    hazard: allForms.filter(f => f.form_type === 'hazard'),
    incident: allForms.filter(f => f.form_type === 'incident'),
    equipment: allForms.find(f => f.form_type === 'equipment') || null,
    vehicle_prestart: allForms.find(f => f.form_type === 'vehicle_prestart') || null,
    risk_toolbox:    allForms.find(f => f.form_type === 'risk_toolbox') || null,
    tc_prestart:     allForms.find(f => f.form_type === 'tc_prestart') || null,
    team_leader:     allForms.find(f => f.form_type === 'team_leader') || null,
    post_shift_vehicle: allForms.find(f => f.form_type === 'post_shift_vehicle') || null,
  };

  // Documents the worker should see on the DOCS tab — drawn from two places:
  //
  //   1. job_documents (admin uploads via /jobs/:id/documents) — scoped to a
  //      job, visible to every shift/booking on it.
  //   2. booking_documents (allocator uploads in the booking detail page when
  //      they put the crew on a shift) — scoped to a single booking, visible
  //      only to the workers allocated to that booking.
  //
  // Both shapes are different tables with different columns, so we normalise
  // them into a single { id, source, doc_type, title, original_name,
  // size_bytes, mime_type, uploaded_at, download_url } shape before sending to
  // the view. The download URL points at the right per-source streamer below.
  const jobLevel = db.prepare(`
    SELECT id, doc_type, title, original_name, mime_type, size_bytes, uploaded_at
    FROM job_documents
    WHERE job_id = ? AND archived_at IS NULL
  `).all(allocation.job_id).map(d => ({
    id: d.id, source: 'job', doc_type: d.doc_type, title: d.title,
    original_name: d.original_name, mime_type: d.mime_type,
    size_bytes: d.size_bytes, uploaded_at: d.uploaded_at,
    download_url: `/w/job-documents/${d.id}`,
  }));

  let bookingLevel = [];
  if (allocation.booking_id) {
    bookingLevel = db.prepare(`
      SELECT id, document_type, title, original_name, file_size, created_at
      FROM booking_documents WHERE booking_id = ?
    `).all(allocation.booking_id).map(d => ({
      id: d.id, source: 'booking', doc_type: d.document_type, title: d.title,
      original_name: d.original_name, mime_type: null,
      size_bytes: d.file_size, uploaded_at: d.created_at,
      download_url: `/w/booking-documents/${d.id}`,
    }));
  }

  // Sort by doc_type priority then most-recent first. Booking docs sit
  // alongside job docs — same priority weights, same chip in the view.
  const DOC_PRIORITY = { tgs:1, tmp:2, ctmp:2, rol_day:3, rol_night:4, rol:3, stage_plan:5, swms:6, permit:7, other:8, photo:9, invoice:10 };
  const jobDocuments = [...jobLevel, ...bookingLevel].sort((a, b) => {
    const pa = DOC_PRIORITY[a.doc_type] || 99;
    const pb = DOC_PRIORITY[b.doc_type] || 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
  });

  // Get docket for this allocation
  const docket = db.prepare(`
    SELECT * FROM docket_signatures
    WHERE crew_member_id = ? AND allocation_id = ?
    ORDER BY signed_at DESC LIMIT 1
  `).get(worker.id, allocation.id);

  res.render('worker/job-detail', {
    title: allocation.job_name || allocation.job_number,
    currentPage: 'shifts',
    tab,
    allocation,
    otherCrew,
    supervisorPhone,
    formStatus,
    docket,
    jobDocuments,
  });
});

// GET /w/booking-documents/:id — Stream a booking-level document. Auth check:
// the worker must have a non-cancelled allocation on the same booking. We
// don't expose the doc to anyone whose shift was reassigned away.
router.get('/booking-documents/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const path = require('path');
  const fs = require('fs');

  const doc = db.prepare(`
    SELECT bd.* FROM booking_documents bd WHERE bd.id = ?
  `).get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = ? AND booking_id = ? AND status != 'cancelled' LIMIT 1
  `).get(worker.id, doc.booking_id);
  if (!linked) return res.status(403).send('Forbidden');

  const abs = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');

  // booking_documents has no mime_type column — guess from extension to keep
  // PDFs inline and other formats downloadable.
  const ext = (path.extname(doc.original_name || '').toLowerCase() || '');
  const mt = ext === '.pdf' ? 'application/pdf'
           : (ext === '.png' || ext === '.jpg' || ext === '.jpeg') ? `image/${ext.slice(1).replace('jpg','jpeg')}`
           : 'application/octet-stream';
  res.setHeader('Content-Type', mt);
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// GET /w/job-documents/:id — Stream an admin-uploaded job document to the
// worker. Permission check: the worker must have an allocation on the same
// job (current or past) before we'll serve the file.
router.get('/job-documents/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const path = require('path');
  const fs = require('fs');

  const doc = db.prepare(`
    SELECT jd.*, j.id AS jid
    FROM job_documents jd
    JOIN jobs j ON jd.job_id = j.id
    WHERE jd.id = ? AND jd.archived_at IS NULL
  `).get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = ? AND job_id = ? AND status != 'cancelled' LIMIT 1
  `).get(worker.id, doc.jid);
  if (!linked) return res.status(403).send('Forbidden');

  const abs = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document.pdf').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// POST /w/jobs/:id/respond — Accept or decline an allocation
router.post('/jobs/:id/respond', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return res.redirect('/w/jobs/' + req.params.id);
  }

  // Verify allocation belongs to this worker and is in 'allocated' status
  const allocation = db.prepare(`
    SELECT id, status FROM crew_allocations
    WHERE id = ? AND crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/jobs');
  }

  if (allocation.status !== 'allocated') {
    req.flash('error', 'This shift has already been ' + allocation.status + '.');
    return res.redirect('/w/jobs/' + req.params.id);
  }

  // Get full allocation details for booking sync
  const fullAlloc = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(allocation.id);

  if (action === 'accept') {
    db.prepare(`
      UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(allocation.id);

    // Sync to booking_crew if linked
    if (fullAlloc && fullAlloc.booking_id) {
      db.prepare("UPDATE booking_crew SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ?")
        .run(fullAlloc.booking_id, worker.id);

      // Check if ALL crew on this booking are now confirmed → auto-set booking to GTG
      const totalCrew = db.prepare("SELECT COUNT(*) as c FROM booking_crew WHERE booking_id = ?").get(fullAlloc.booking_id);
      const confirmedCrew = db.prepare("SELECT COUNT(*) as c FROM booking_crew WHERE booking_id = ? AND status = 'confirmed'").get(fullAlloc.booking_id);
      if (totalCrew && confirmedCrew && totalCrew.c > 0 && confirmedCrew.c >= totalCrew.c) {
        const booking = db.prepare("SELECT status FROM bookings WHERE id = ?").get(fullAlloc.booking_id);
        if (booking && booking && (booking.status === 'confirmed' || booking.status === 'unconfirmed')) {
          db.prepare("UPDATE bookings SET status = 'green_to_go', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(fullAlloc.booking_id);
        }
      }
    }

    req.flash('success', 'Shift accepted!');
  } else {
    db.prepare(`
      UPDATE crew_allocations SET status = 'declined'
      WHERE id = ?
    `).run(allocation.id);

    // Sync to booking_crew if linked
    if (fullAlloc && fullAlloc.booking_id) {
      db.prepare("UPDATE booking_crew SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ?")
        .run(fullAlloc.booking_id, worker.id);
    }

    req.flash('success', 'Shift declined.');
  }

  res.redirect('/w/jobs/' + req.params.id);
});

// GET /w/booking-shift/:bookingId — Booking detail (for booking_crew-based shifts)
router.get('/booking-shift/:bookingId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const tab = req.query.tab || 'details';

  // Get booking details
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.bookingId);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/w/jobs'); }

  // Verify this worker is assigned to this booking
  const myAssignment = db.prepare('SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(booking.id, worker.id);
  if (!myAssignment) { req.flash('error', 'You are not assigned to this booking.'); return res.redirect('/w/jobs'); }

  // Lazy-bind a crew_allocations row to this booking_crew assignment so the
  // Job-Pack form flow (which keys off allocation_id) works for booking-only
  // shifts. If the allocator didn't create one when they assigned the worker,
  // create one here on first detail visit. Allocator-confirmed work surfaces
  // as a 'confirmed' allocation; pending work as 'allocated' so the worker
  // can accept/decline.
  let allocation = db.prepare(`
    SELECT * FROM crew_allocations
    WHERE booking_id = ? AND crew_member_id = ? LIMIT 1
  `).get(booking.id, worker.id);
  if (!allocation && booking.job_id) {
    try {
      const allocStatus = myAssignment.status === 'confirmed' ? 'confirmed' : 'allocated';
      const startTimeFromDt = booking.start_datetime ? booking.start_datetime.substring(11, 16) : '';
      const endTimeFromDt   = booking.end_datetime   ? booking.end_datetime.substring(11, 16)   : '';
      const allocDate       = booking.start_datetime ? booking.start_datetime.substring(0, 10)  : new Date().toISOString().slice(0, 10);
      const allocBy = booking.created_by_id || (req.session.user && req.session.user.id) || null;
      const ins = db.prepare(`
        INSERT INTO crew_allocations
          (job_id, crew_member_id, allocation_date, start_time, end_time,
           role_on_site, status, allocated_by_id, booking_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(booking.job_id, worker.id, allocDate, startTimeFromDt, endTimeFromDt,
             myAssignment.role_on_site || '', allocStatus, allocBy, booking.id);
      allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(ins.lastInsertRowid);
    } catch (e) {
      // Allocator-managed bookings without job_id can't auto-bind — surface
      // the problem in the log rather than the worker UI.
      console.error('[booking-shift] failed to lazy-bind allocation:', e.message);
    }
  }

  // Get all crew on this booking
  const crew = db.prepare(`
    SELECT bc.*, cm.full_name, cm.phone, cm.role
    FROM booking_crew bc
    JOIN crew_members cm ON bc.crew_member_id = cm.id
    WHERE bc.booking_id = ?
    ORDER BY cm.full_name
  `).all(booking.id);

  // Get client name from client_id if available
  let clientName = '';
  if (booking.client_id) {
    try { const client = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(booking.client_id); if (client) clientName = client.company_name; } catch (e) {}
  }
  booking.client_name = clientName || booking.client_contact || '';

  // Format dates
  const startDt = booking.start_datetime ? new Date(booking.start_datetime) : new Date();
  const startDay = startDt.toLocaleDateString('en-AU', { weekday: 'long' });
  const startDate = startDt.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const startTime = booking.start_datetime ? booking.start_datetime.substring(11, 16) : '';
  const endTime = booking.end_datetime ? booking.end_datetime.substring(11, 16) : '';

  // Job-Pack completion + docket status — only when we have an allocation
  // to hang submissions off (so a booking with no job_id stays informational).
  const JP_TYPES = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];
  let formStatus = {}, docket = null, jobDocuments = [];
  if (allocation) {
    const subs = db.prepare(`
      SELECT id, form_type, submitted_at FROM safety_forms
      WHERE crew_member_id = ? AND allocation_id = ?
        AND form_type IN (${JP_TYPES.map(()=>'?').join(',')})
    `).all(worker.id, allocation.id, ...JP_TYPES);
    for (const t of JP_TYPES) {
      const hit = subs.find(s => s.form_type === t);
      formStatus[t] = hit ? { id: hit.id, submitted_at: hit.submitted_at } : null;
    }
    docket = db.prepare(`
      SELECT id, signed_at, total_hours FROM docket_signatures
      WHERE crew_member_id = ? AND allocation_id = ? ORDER BY signed_at DESC LIMIT 1
    `).get(worker.id, allocation.id);

    // Site documents — same shape as the allocation detail page so the view
    // can reuse the rendering. Job-level docs + booking-level docs merged
    // and sorted by doc-type priority.
    try {
      const jobLevel = booking.job_id ? db.prepare(`
        SELECT id, doc_type, title, original_name, mime_type, size_bytes, uploaded_at
        FROM job_documents WHERE job_id = ? AND archived_at IS NULL
      `).all(booking.job_id).map(d => ({
        id: d.id, source: 'job', doc_type: d.doc_type, title: d.title,
        original_name: d.original_name, mime_type: d.mime_type,
        size_bytes: d.size_bytes, uploaded_at: d.uploaded_at,
        download_url: `/w/job-documents/${d.id}`,
      })) : [];
      const bookingLevel = db.prepare(`
        SELECT id, document_type, title, original_name, file_size, created_at
        FROM booking_documents WHERE booking_id = ?
      `).all(booking.id).map(d => ({
        id: d.id, source: 'booking', doc_type: d.document_type, title: d.title,
        original_name: d.original_name, mime_type: null,
        size_bytes: d.file_size, uploaded_at: d.created_at,
        download_url: `/w/booking-documents/${d.id}`,
      }));
      const DOC_PRIORITY = { tgs:1, tmp:2, ctmp:2, rol_day:3, rol_night:4, rol:3, stage_plan:5, swms:6, permit:7, other:8, photo:9, invoice:10 };
      jobDocuments = [...jobLevel, ...bookingLevel].sort((a, b) => {
        const pa = DOC_PRIORITY[a.doc_type] || 99;
        const pb = DOC_PRIORITY[b.doc_type] || 99;
        if (pa !== pb) return pa - pb;
        return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
      });
    } catch (e) { console.error('[booking-shift] doc fetch:', e.message); }
  }

  res.render('worker/booking-detail', {
    title: booking.title || booking.booking_number,
    currentPage: 'shifts',
    tab,
    booking,
    crew,
    myStatus: myAssignment.status,
    startDay, startDate, startTime, endTime,
    allocation, formStatus, docket, jobDocuments,
  });
});

// POST /w/bookings/:id/respond — Accept or decline a booking_crew assignment (no allocation)
router.post('/bookings/:id/respond', (req, res) => {
  try {
  const db = getDb();
  const worker = req.session.worker;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return res.redirect('/w/booking-shift/' + req.params.id);
  }

  const bc = db.prepare("SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?").get(req.params.id, worker.id);
  if (!bc) { req.flash('error', 'Assignment not found.'); return res.redirect('/w/jobs'); }

  if (action === 'accept') {
    db.prepare("UPDATE booking_crew SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ?")
      .run(req.params.id, worker.id);

    // Check if ALL crew confirmed → auto-GTG
    const total = db.prepare("SELECT COUNT(*) as c FROM booking_crew WHERE booking_id = ?").get(req.params.id);
    const conf = db.prepare("SELECT COUNT(*) as c FROM booking_crew WHERE booking_id = ? AND status = 'confirmed'").get(req.params.id);
    if (total && conf && total.c > 0 && conf.c >= total.c) {
      const booking = db.prepare("SELECT status FROM bookings WHERE id = ?").get(req.params.id);
      if (booking && booking && (booking.status === 'confirmed' || booking.status === 'unconfirmed')) {
        db.prepare("UPDATE bookings SET status = 'green_to_go', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
      }
    }
    req.flash('success', 'Shift accepted!');
  } else {
    db.prepare("UPDATE booking_crew SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ?")
      .run(req.params.id, worker.id);
    req.flash('success', 'Shift declined.');
  }

  res.redirect('/w/booking-shift/' + req.params.id);
  } catch (err) {
    console.error('Booking respond error:', err.message);
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/w/jobs');
  }
});

module.exports = router;
