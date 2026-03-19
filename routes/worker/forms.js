const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/forms — Form type selector
router.get('/forms', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Count recent submissions
  const recentCount = db.prepare('SELECT COUNT(*) as c FROM safety_forms WHERE crew_member_id = ? AND submitted_at >= datetime(\'now\', \'-7 days\')').get(worker.id).c;

  res.render('worker/forms/index', {
    title: 'Safety Forms',
    currentPage: 'more',
    recentCount,
  });
});

// GET /w/forms/prestart
router.get('/forms/prestart', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];

  const todaysShifts = db.prepare(`
    SELECT ca.id, j.job_number, j.client FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  res.render('worker/forms/prestart', {
    title: 'Pre-Start Checklist',
    currentPage: 'more',
    todaysShifts,
  });
});

// POST /w/forms/prestart
router.post('/forms/prestart', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { allocation_id, ...checklistData } = req.body;

  // Remove _csrf from data
  delete checklistData._csrf;

  const allocation = allocation_id ? db.prepare('SELECT job_id FROM crew_allocations WHERE id = ?').get(allocation_id) : null;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, data, status, latitude, longitude)
    VALUES (?, 'prestart', ?, ?, ?, 'submitted', ?, ?)
  `).run(worker.id, allocation ? allocation.job_id : null, allocation_id || null, JSON.stringify(checklistData), req.body.latitude || null, req.body.longitude || null);

  req.flash('success', 'Pre-start checklist submitted.');
  res.redirect('/w/forms');
});

// GET /w/forms/take5
router.get('/forms/take5', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];

  const todaysShifts = db.prepare(`
    SELECT ca.id, j.job_number, j.client FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  res.render('worker/forms/take5', {
    title: 'Take 5 Safety Check',
    currentPage: 'more',
    todaysShifts,
  });
});

// POST /w/forms/take5
router.post('/forms/take5', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { allocation_id, ...formData } = req.body;
  delete formData._csrf;

  const allocation = allocation_id ? db.prepare('SELECT job_id FROM crew_allocations WHERE id = ?').get(allocation_id) : null;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, data, status)
    VALUES (?, 'take5', ?, ?, ?, 'submitted')
  `).run(worker.id, allocation ? allocation.job_id : null, allocation_id || null, JSON.stringify(formData));

  req.flash('success', 'Take 5 submitted.');
  res.redirect('/w/forms');
});

// GET /w/forms/incident
router.get('/forms/incident', (req, res) => {
  res.render('worker/forms/incident', {
    title: 'Report Incident',
    currentPage: 'more',
  });
});

// POST /w/forms/incident
router.post('/forms/incident', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { incident_type, severity, title, description, location, latitude, longitude } = req.body;

  if (!title || !description) {
    req.flash('error', 'Title and description are required.');
    return res.redirect('/w/forms/incident');
  }

  // Generate incident number
  const count = db.prepare('SELECT COUNT(*) as c FROM incidents').get().c;
  const incidentNumber = 'INC-' + String(count + 1).padStart(4, '0');

  // Insert into incidents table for admin visibility
  try {
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, investigation_status, reported_by_crew_id)
      VALUES (?, ?, ?, ?, ?, ?, 'reported', ?)
    `).run(incidentNumber, incident_type || 'other', severity || 'medium', title, description, location || null, worker.id);
  } catch(e) {
    // If reported_by_crew_id column doesn't exist yet, try without it
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, investigation_status)
      VALUES (?, ?, ?, ?, ?, ?, 'reported')
    `).run(incidentNumber, incident_type || 'other', severity || 'medium', title, description, location || null);
  }

  // Also insert into safety_forms
  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status, latitude, longitude)
    VALUES (?, 'incident', ?, 'submitted', ?, ?)
  `).run(worker.id, JSON.stringify({ incident_type, severity, title, description, location, incident_number: incidentNumber }), latitude || null, longitude || null);

  req.flash('success', 'Incident reported: ' + incidentNumber);
  res.redirect('/w/forms');
});

// GET /w/forms/hazard
router.get('/forms/hazard', (req, res) => {
  res.render('worker/forms/hazard', {
    title: 'Report Hazard',
    currentPage: 'more',
  });
});

// POST /w/forms/hazard
router.post('/forms/hazard', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { ...formData } = req.body;
  delete formData._csrf;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status, latitude, longitude)
    VALUES (?, 'hazard', ?, 'submitted', ?, ?)
  `).run(worker.id, JSON.stringify(formData), req.body.latitude || null, req.body.longitude || null);

  req.flash('success', 'Hazard reported.');
  res.redirect('/w/forms');
});

// GET /w/forms/equipment
router.get('/forms/equipment', (req, res) => {
  res.render('worker/forms/equipment', {
    title: 'Equipment Check',
    currentPage: 'more',
  });
});

// POST /w/forms/equipment
router.post('/forms/equipment', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { ...formData } = req.body;
  delete formData._csrf;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status)
    VALUES (?, 'equipment', ?, 'submitted')
  `).run(worker.id, JSON.stringify(formData));

  req.flash('success', 'Equipment check submitted.');
  res.redirect('/w/forms');
});

// GET /w/forms/history — My submitted forms
router.get('/forms/history', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const forms = db.prepare(`
    SELECT sf.*, j.job_number, j.client
    FROM safety_forms sf
    LEFT JOIN jobs j ON sf.job_id = j.id
    WHERE sf.crew_member_id = ?
    ORDER BY sf.created_at DESC LIMIT 50
  `).all(worker.id);

  res.render('worker/forms/history', {
    title: 'Form History',
    currentPage: 'more',
    forms,
  });
});

module.exports = router;
