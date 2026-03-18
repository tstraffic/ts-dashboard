const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

const DEPOTS = ['Villawood', 'Penrith', 'Campbelltown', 'Parramatta'];
const VALID_STATUSES = ['unconfirmed', 'confirmed', 'green_to_go', 'in_progress', 'completed', 'cancelled', 'on_hold'];

function generateBookingNumber(db) {
  const last = db.prepare("SELECT booking_number FROM bookings ORDER BY id DESC LIMIT 1").get();
  let nextNum = 1;
  if (last && last.booking_number) {
    const num = parseInt(last.booking_number.replace('BK-', ''), 10);
    if (!isNaN(num)) nextNum = num + 1;
  }
  return 'BK-' + String(nextNum).padStart(4, '0');
}

function transformBooking(db, row) {
  const crew = db.prepare(`
    SELECT bc.id, bc.crew_member_id, bc.role_on_site, bc.status, cm.full_name
    FROM booking_crew bc LEFT JOIN crew_members cm ON cm.id = bc.crew_member_id
    WHERE bc.booking_id = ?
  `).all(row.id);
  const vehicles = db.prepare("SELECT id, vehicle_name, registration FROM booking_vehicles WHERE booking_id = ?").all(row.id);
  const noteCount = db.prepare("SELECT COUNT(*) as c FROM booking_notes WHERE booking_id = ?").get(row.id).c;

  let supervisorName = '';
  if (row.supervisor_id) {
    const sup = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(row.supervisor_id);
    if (sup) supervisorName = sup.full_name;
  }

  let projectName = row.title || '', clientName = '', projectAddress = row.site_address || '';
  if (row.job_id) {
    const job = db.prepare("SELECT job_name, client, site_address FROM jobs WHERE id = ?").get(row.job_id);
    if (job) { projectName = projectName || job.job_name; clientName = job.client || ''; projectAddress = projectAddress || job.site_address || ''; }
  }
  if (row.client_id) {
    try { const client = db.prepare("SELECT company_name FROM clients WHERE id = ?").get(row.client_id); if (client) clientName = client.company_name; } catch (e) {}
  }

  let scheduleWarning = null;
  for (const c of crew) {
    const conflict = db.prepare(`
      SELECT b.booking_number FROM booking_crew bc2 JOIN bookings b ON b.id = bc2.booking_id
      WHERE bc2.crew_member_id = ? AND bc2.booking_id != ? AND b.status NOT IN ('cancelled','completed')
        AND b.start_datetime < ? AND b.end_datetime > ? LIMIT 1
    `).get(c.crew_member_id, row.id, row.end_datetime, row.start_datetime);
    if (conflict) { scheduleWarning = c.full_name + ' also on ' + conflict.booking_number; break; }
  }

  return {
    id: row.id, booking_number: row.booking_number, status: row.status,
    startDateTime: row.start_datetime, endDateTime: row.end_datetime,
    depot: row.depot || '', supervisor: supervisorName,
    project: { name: projectName, client: clientName, address: projectAddress, orderNumber: row.order_number || '', billingCode: row.billing_code || '' },
    personnel: crew.map(c => ({ id: c.crew_member_id, name: c.full_name || 'Unknown', role: c.role_on_site || '', confirmed: c.status === 'confirmed' })),
    vehicles: vehicles.map(v => ({ id: v.id, registration: v.registration || '', name: v.vehicle_name || '' })),
    scheduleWarning, dockets: 0, notes: noteCount, tasks: 0, docs: 0,
  };
}

function loadBookingDetail(db, bookingId) {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!row) return null;
  const crew = db.prepare(`SELECT bc.*, cm.full_name, cm.phone, cm.email, cm.role as crew_role, cm.employee_id FROM booking_crew bc LEFT JOIN crew_members cm ON cm.id = bc.crew_member_id WHERE bc.booking_id = ? ORDER BY bc.created_at`).all(bookingId);
  const notes = db.prepare(`SELECT bn.*, u.full_name as author_name FROM booking_notes bn LEFT JOIN users u ON u.id = bn.user_id WHERE bn.booking_id = ? ORDER BY bn.created_at DESC`).all(bookingId);
  const vehicles = db.prepare("SELECT * FROM booking_vehicles WHERE booking_id = ? ORDER BY created_at").all(bookingId);
  let supervisorName = '';
  if (row.supervisor_id) { const sup = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(row.supervisor_id); if (sup) supervisorName = sup.full_name; }
  let jobInfo = row.job_id ? db.prepare("SELECT id, job_number, job_name, client, site_address, suburb, status FROM jobs WHERE id = ?").get(row.job_id) : null;
  let clientInfo = null;
  if (row.client_id) { try { clientInfo = db.prepare("SELECT id, company_name, primary_contact_name, primary_contact_phone, primary_contact_email FROM clients WHERE id = ?").get(row.client_id); } catch (e) {} }
  return { ...row, supervisor_name: supervisorName, crew, notes, vehicles, job: jobInfo, client: clientInfo };
}

// GET / — Board view
router.get('/', (req, res) => {
  const db = getDb();
  const view = req.query.view || 'board';
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  const depot = req.query.depot || '', status = req.query.status || '', search = req.query.search || '';

  let where = "WHERE DATE(b.start_datetime) = ?";
  const params = [dateStr];
  if (depot) { where += " AND b.depot = ?"; params.push(depot); }
  if (status) { where += " AND b.status = ?"; params.push(status); }
  if (search) { where += " AND (b.title LIKE ? OR b.booking_number LIKE ? OR b.site_address LIKE ? OR b.suburb LIKE ?)"; const s = '%' + search + '%'; params.push(s, s, s, s); }

  const rows = db.prepare(`SELECT b.* FROM bookings b ${where} ORDER BY b.start_datetime ASC`).all(...params);
  const bookings = rows.map(r => transformBooking(db, r));
  const allForDate = db.prepare("SELECT status FROM bookings WHERE DATE(start_datetime) = ?").all(dateStr);
  const stats = {
    total: allForDate.length, completed: allForDate.filter(r => r.status === 'completed').length,
    greenToGo: allForDate.filter(r => r.status === 'green_to_go').length, confirmed: allForDate.filter(r => r.status === 'confirmed').length,
    unconfirmed: allForDate.filter(r => r.status === 'unconfirmed').length, inProgress: allForDate.filter(r => r.status === 'in_progress').length,
    cancelled: allForDate.filter(r => r.status === 'cancelled').length,
  };

  res.render('bookings/index', { title: 'Bookings Board', bookings, stats, depots: DEPOTS, currentView: view, currentDate: dateStr, currentDepot: depot, currentStatus: status, currentSearch: search, user: req.session.user });
});

// GET /new
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, job_name, client FROM jobs WHERE status != 'cancelled' ORDER BY job_name").all();
  let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
  const supervisors = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.render('bookings/form', { title: 'New Booking', booking: null, jobs, clients, supervisors, depots: DEPOTS, user: req.session.user });
});

// POST / — Create booking
router.post('/', (req, res) => {
  const db = getDb(); const b = req.body;
  if (!b.title || !b.start_date || !b.start_time || !b.end_date || !b.end_time) { req.flash('error', 'Title and schedule are required.'); return res.redirect('/bookings/new'); }
  const bookingNumber = generateBookingNumber(db);
  const result = db.prepare(`
    INSERT INTO bookings (booking_number, job_id, client_id, title, description, status, depot, start_datetime, end_datetime, site_address, suburb, state, postcode, order_number, billing_code, client_contact, supervisor_id, requirements_text, is_emergency, is_callout, billable, invoiced, notes, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(bookingNumber, b.job_id || null, b.client_id || null, b.title, b.description || '', b.status || 'unconfirmed', b.depot || '',
    b.start_date + 'T' + b.start_time + ':00', b.end_date + 'T' + b.end_time + ':00',
    b.site_address || '', b.suburb || '', b.state || '', b.postcode || '', b.order_number || '', b.billing_code || '', b.client_contact || '',
    b.supervisor_id || null, b.requirements_text || '', b.is_emergency ? 1 : 0, b.is_callout ? 1 : 0, b.billable ? 1 : 0, b.notes || '', req.session.user.id);
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: result.lastInsertRowid, details: `Created booking ${bookingNumber}`, req });
  req.flash('success', `Booking ${bookingNumber} created.`);
  res.redirect('/bookings');
});

// GET /resources — Available crew (JSON)
router.get('/resources', (req, res) => {
  const db = getDb(); const date = req.query.date || new Date().toISOString().split('T')[0];
  const assignedIds = db.prepare(`SELECT DISTINCT bc.crew_member_id FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id WHERE DATE(b.start_datetime) = ? AND b.status NOT IN ('cancelled','completed')`).all(date).map(r => r.crew_member_id);
  const allCrew = db.prepare("SELECT id, full_name, role, phone, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.json({ date, available: allCrew.filter(c => !assignedIds.includes(c.id)), assigned: allCrew.filter(c => assignedIds.includes(c.id)) });
});

// GET /:id — Detail (JSON or show page)
router.get('/:id', (req, res) => {
  const db = getDb(); const booking = loadBookingDetail(db, req.params.id);
  if (!booking) { if (req.headers.accept && req.headers.accept.includes('application/json')) return res.status(404).json({ error: 'Booking not found' }); req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    const t = transformBooking(db, booking);
    return res.json({ ...t, booking_number: booking.booking_number, description: booking.description, requirements_text: booking.requirements_text, order_number: booking.order_number, billing_code: booking.billing_code, client_contact: booking.client_contact, is_emergency: booking.is_emergency, is_callout: booking.is_callout, billable: booking.billable, invoiced: booking.invoiced, site_address: booking.site_address, suburb: booking.suburb, state: booking.state, postcode: booking.postcode, crew: booking.crew, allNotes: booking.notes, allVehicles: booking.vehicles, job: booking.job, client: booking.client });
  }
  const allCrew = db.prepare("SELECT id, full_name, role, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.render('bookings/show', {
    title: 'Booking ' + booking.booking_number,
    booking: { ...booking, supervisor: booking.supervisor_name, project: { name: booking.title || (booking.job ? booking.job.job_name : ''), client: booking.client ? booking.client.company_name : (booking.job ? booking.job.client : ''), address: booking.site_address || (booking.job ? booking.job.site_address : ''), orderNumber: booking.order_number, billingCode: booking.billing_code },
      startDateTime: booking.start_datetime, endDateTime: booking.end_datetime,
      personnel: booking.crew.map(c => ({ id: c.crew_member_id, name: c.full_name || 'Unknown', role: c.role_on_site || '', confirmed: c.status === 'confirmed', bcStatus: c.status })),
      allVehicles: booking.vehicles },
    allCrew, user: req.session.user,
  });
});

// GET /:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb(); const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  if (booking.start_datetime) { const p = booking.start_datetime.split('T'); booking.start_date = p[0]; booking.start_time = (p[1] || '').substring(0, 5); }
  if (booking.end_datetime) { const p = booking.end_datetime.split('T'); booking.end_date = p[0]; booking.end_time = (p[1] || '').substring(0, 5); }
  const jobs = db.prepare("SELECT id, job_number, job_name, client FROM jobs WHERE status != 'cancelled' ORDER BY job_name").all();
  let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
  const supervisors = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.render('bookings/form', { title: 'Edit Booking ' + booking.booking_number, booking, jobs, clients, supervisors, depots: DEPOTS, user: req.session.user });
});

// POST /:id — Update
router.post('/:id', (req, res) => {
  const db = getDb(); const existing = db.prepare("SELECT id, booking_number FROM bookings WHERE id = ?").get(req.params.id);
  if (!existing) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  const b = req.body;
  if (!b.title || !b.start_date || !b.start_time || !b.end_date || !b.end_time) { req.flash('error', 'Title and schedule are required.'); return res.redirect('/bookings/' + req.params.id + '/edit'); }
  db.prepare(`UPDATE bookings SET job_id=?, client_id=?, title=?, description=?, status=?, depot=?, start_datetime=?, end_datetime=?, site_address=?, suburb=?, state=?, postcode=?, order_number=?, billing_code=?, client_contact=?, supervisor_id=?, requirements_text=?, is_emergency=?, is_callout=?, billable=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.job_id || null, b.client_id || null, b.title, b.description || '', b.status || 'unconfirmed', b.depot || '', b.start_date + 'T' + b.start_time + ':00', b.end_date + 'T' + b.end_time + ':00', b.site_address || '', b.suburb || '', b.state || '', b.postcode || '', b.order_number || '', b.billing_code || '', b.client_contact || '', b.supervisor_id || null, b.requirements_text || '', b.is_emergency ? 1 : 0, b.is_callout ? 1 : 0, b.billable ? 1 : 0, b.notes || '', req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Updated booking ${existing.booking_number}`, req });
  req.flash('success', `Booking ${existing.booking_number} updated.`); res.redirect('/bookings/' + req.params.id);
});

// POST /:id/status
router.post('/:id/status', (req, res) => {
  const db = getDb(); const newStatus = req.body.status;
  if (!VALID_STATUSES.includes(newStatus)) { req.flash('error', 'Invalid status.'); return res.redirect('back'); }
  const existing = db.prepare("SELECT id, booking_number, status FROM bookings WHERE id = ?").get(req.params.id);
  if (!existing) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  db.prepare("UPDATE bookings SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(newStatus, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Status: ${existing.status} → ${newStatus} on ${existing.booking_number}`, req });
  req.flash('success', `Status updated to ${newStatus.replace(/_/g, ' ')}.`); res.redirect('/bookings/' + req.params.id);
});

// Crew management
router.post('/:id/crew', (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  const { crew_member_id, role_on_site } = req.body;
  if (!crew_member_id) { req.flash('error', 'Select a crew member.'); return res.redirect('/bookings/' + req.params.id); }
  if (db.prepare("SELECT id FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, crew_member_id)) { req.flash('error', 'Already assigned.'); return res.redirect('/bookings/' + req.params.id); }
  db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')").run(req.params.id, crew_member_id, role_on_site || '');
  req.flash('success', 'Crew member added.'); res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/crew/:crewId/remove', (req, res) => { getDb().prepare("DELETE FROM booking_crew WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId); req.flash('success', 'Removed.'); res.redirect('/bookings/' + req.params.id); });
router.post('/:id/crew/:crewId/confirm', (req, res) => { getDb().prepare("UPDATE booking_crew SET status='confirmed', confirmed_at=CURRENT_TIMESTAMP WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId); req.flash('success', 'Confirmed.'); res.redirect('/bookings/' + req.params.id); });

// Notes
router.post('/:id/notes', (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) { req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const { content, is_private } = req.body;
  if (!content || !content.trim()) { req.flash('error', 'Content required.'); return res.redirect('/bookings/' + req.params.id); }
  db.prepare("INSERT INTO booking_notes (booking_id, user_id, content, is_private) VALUES (?, ?, ?, ?)").run(req.params.id, req.session.user.id, content.trim(), is_private ? 1 : 0);
  req.flash('success', 'Note added.'); res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/notes/:noteId/delete', (req, res) => { getDb().prepare("DELETE FROM booking_notes WHERE id=? AND booking_id=?").run(req.params.noteId, req.params.id); req.flash('success', 'Deleted.'); res.redirect('/bookings/' + req.params.id); });

// Vehicles
router.post('/:id/vehicles', (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) { req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const { vehicle_name, registration } = req.body;
  if (!vehicle_name && !registration) { req.flash('error', 'Name or rego required.'); return res.redirect('/bookings/' + req.params.id); }
  db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration) VALUES (?, ?, ?)").run(req.params.id, vehicle_name || '', registration || '');
  req.flash('success', 'Vehicle added.'); res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/vehicles/:vehicleId/remove', (req, res) => { getDb().prepare("DELETE FROM booking_vehicles WHERE id=? AND booking_id=?").run(req.params.vehicleId, req.params.id); req.flash('success', 'Removed.'); res.redirect('/bookings/' + req.params.id); });

// Clone
router.post('/:id/clone', (req, res) => {
  const db = getDb(); const source = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!source) { req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const bookingNumber = generateBookingNumber(db);
  function addDay(dt) { if (!dt) return dt; const d = new Date(dt); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${(dt.split('T')[1] || '00:00:00')}`; }
  const result = db.prepare(`INSERT INTO bookings (booking_number, job_id, client_id, title, description, status, depot, start_datetime, end_datetime, site_address, suburb, state, postcode, order_number, billing_code, client_contact, supervisor_id, requirements_text, is_emergency, is_callout, billable, invoiced, notes, created_by_id)
    VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
    bookingNumber, source.job_id, source.client_id, source.title, source.description, source.depot, addDay(source.start_datetime), addDay(source.end_datetime),
    source.site_address, source.suburb, source.state, source.postcode, source.order_number, source.billing_code, source.client_contact, source.supervisor_id,
    source.requirements_text, source.is_emergency, source.is_callout, source.billable, source.notes, req.session.user.id);
  const newId = result.lastInsertRowid;
  for (const c of db.prepare("SELECT crew_member_id, role_on_site FROM booking_crew WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')").run(newId, c.crew_member_id, c.role_on_site);
  for (const v of db.prepare("SELECT vehicle_name, registration, notes FROM booking_vehicles WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, notes) VALUES (?, ?, ?, ?)").run(newId, v.vehicle_name, v.registration, v.notes);
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: newId, details: `Cloned ${source.booking_number} → ${bookingNumber}`, req });
  req.flash('success', `Cloned as ${bookingNumber}.`); res.redirect('/bookings/' + newId);
});

module.exports = router;
