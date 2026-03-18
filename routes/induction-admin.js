const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { employeeGuideSlides, tcTrainingSlides } = require('../induction-slides');

// GET /induction/admin/submissions — list all submissions with filtering
router.get('/submissions', (req, res) => {
  const { status, payment_type, search, date_from, date_to } = req.query;

  let where = [];
  let params = [];

  if (status && status !== 'all') {
    where.push('s.status = ?');
    params.push(status);
  }
  if (payment_type && payment_type !== 'all') {
    where.push('s.payment_type = ?');
    params.push(payment_type);
  }
  if (search) {
    where.push("(s.full_name LIKE ? OR s.email LIKE ? OR s.phone LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (date_from) {
    where.push('s.submitted_at >= ?');
    params.push(date_from);
  }
  if (date_to) {
    where.push('s.submitted_at <= ?');
    params.push(date_to + ' 23:59:59');
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const submissions = getDb().prepare(`
    SELECT s.*, u.full_name as reviewed_by_name
    FROM induction_submissions s
    LEFT JOIN users u ON s.reviewed_by_id = u.id
    ${whereClause}
    ORDER BY s.submitted_at DESC
  `).all(...params);

  const stats = {
    total: getDb().prepare('SELECT COUNT(*) as c FROM induction_submissions').get().c,
    submitted: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'submitted'").get().c,
    approved: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'approved'").get().c,
    rejected: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'rejected'").get().c,
    converted: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'approved' AND linked_crew_member_id IS NOT NULL").get().c,
  };

  res.render('induction/admin/submissions', {
    title: 'Induction Submissions',
    currentPage: 'induction',
    submissions,
    filters: { status: status || 'all', payment_type: payment_type || 'all', search: search || '', date_from: date_from || '', date_to: date_to || '' },
    stats,
  });
});

// GET /induction/admin/submissions/:id — view single submission
router.get('/submissions/:id', (req, res) => {
  const submission = getDb().prepare(`
    SELECT s.*, u.full_name as reviewed_by_name
    FROM induction_submissions s
    LEFT JOIN users u ON s.reviewed_by_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!submission) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Submission not found', user: req.session.user });
  }

  res.render('induction/admin/submission-detail', {
    title: submission.full_name || 'Submission',
    currentPage: 'induction',
    submission,
  });
});

// POST /induction/admin/submissions/:id/status — approve/reject
router.post('/submissions/:id/status', (req, res) => {
  const { status, review_notes } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).send('Invalid status');
  }

  const db = getDb();
  const s = db.prepare('SELECT * FROM induction_submissions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).send('Submission not found');

  // Update submission status
  db.prepare(`
    UPDATE induction_submissions
    SET status = ?, reviewed_by_id = ?, reviewed_at = datetime('now'), review_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, req.session.user.id, review_notes || '', req.params.id);

  // If approved, auto-create Crew Member + Employee records
  if (status === 'approved') {
    try {
      // Generate next employee ID (EMP-001, EMP-002, etc.)
      const lastCrew = db.prepare("SELECT employee_id FROM crew_members WHERE employee_id LIKE 'EMP-%' ORDER BY employee_id DESC LIMIT 1").get();
      let nextNum = 1;
      if (lastCrew && lastCrew.employee_id) {
        const num = parseInt(lastCrew.employee_id.replace('EMP-', ''), 10);
        if (!isNaN(num)) nextNum = num + 1;
      }
      const employeeId = `EMP-${String(nextNum).padStart(3, '0')}`;

      // Use split name fields (fall back to splitting full_name for old submissions)
      let firstName = (s.first_name || '').trim();
      let middleName = (s.middle_name || '').trim();
      let lastName = (s.last_name || '').trim();
      if (!firstName && !lastName && s.full_name) {
        const nameParts = s.full_name.trim().split(/\s+/);
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
      }
      const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ') || s.full_name || '';

      // Determine employment type from payment type
      const employmentType = s.payment_type === 'abn' ? 'subcontractor' : 'casual';

      // 1. Create Crew Member
      const crewResult = db.prepare(`
        INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type,
          white_card, licence_type, induction_date, induction_status, active, status)
        VALUES (?, ?, 'TC', ?, ?, 'T&S Traffic Control', ?, ?, ?, date('now'), 'completed', 1, 'active')
      `).run(
        fullName, employeeId, s.phone || '', s.email || '', employmentType,
        s.white_card_number || '', s.drivers_licence_number || ''
      );
      const crewMemberId = crewResult.lastInsertRowid;

      // 2. Create Employee record linked to crew member
      db.prepare(`
        INSERT INTO employees (employee_code, first_name, middle_name, last_name, full_name, company,
          employment_type, employment_status, payment_type, start_date,
          email, phone, address, suburb, state, postcode,
          date_of_birth, induction_status, allocatable, active,
          linked_crew_member_id, internal_notes)
        VALUES (?, ?, ?, ?, ?, 'T&S Traffic Control', ?, 'active', ?, date('now'), ?, ?, ?, ?, ?, ?, ?, 'completed', 1, 1, ?, ?)
      `).run(
        employeeId, firstName, middleName, lastName, fullName, employmentType,
        s.payment_type || '',
        s.email || '', s.phone || '', s.address || '', s.suburb || '', s.state || '', s.postcode || '',
        s.date_of_birth || null, crewMemberId,
        `Auto-created from induction #${s.id}. Payment: ${s.payment_type}. Bank: ${s.bank_name || ''} BSB: ${s.bank_bsb || ''} Acc: ${s.bank_account_number || ''} AccName: ${s.bank_account_name || ''}`
      );

      // 3. Update submission with link to crew member (stay as 'approved' — conversion tracked by linked_crew_member_id)
      db.prepare(`
        UPDATE induction_submissions SET linked_crew_member_id = ?, updated_at = datetime('now') WHERE id = ?
      `).run(crewMemberId, s.id);

      req.flash('success', `${fullName} approved and added as employee ${employeeId}. They now appear in Crew Roster and Employees.`);
      return res.redirect(`/induction/admin/submissions/${req.params.id}`);
    } catch (err) {
      console.error('Auto-convert error:', err);
      req.flash('error', `Approved but failed to create employee record: ${err.message}`);
      return res.redirect(`/induction/admin/submissions/${req.params.id}`);
    }
  }

  req.flash('success', `Submission ${status} successfully.`);
  res.redirect(`/induction/admin/submissions/${req.params.id}`);
});

// Serve uploaded induction files (authenticated)
// View URLs: /induction/admin/uploads/:id/:filename — :id is for context only, files are stored flat
router.get('/uploads/:id/:filename', (req, res) => {
  const filePath = path.join(__dirname, '..', 'uploads', 'inductions', req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.sendFile(filePath);
});

// GET /induction/admin/present/:module — slide presenter
router.get('/present/:module', (req, res) => {
  const { module } = req.params;
  let slides, moduleTitle;

  if (module === 'employee-guide') {
    slides = employeeGuideSlides;
    moduleTitle = 'T&S Employee Guide';
  } else if (module === 'tc-training-1') {
    slides = tcTrainingSlides;
    moduleTitle = 'Traffic Control Training — Module 1';
  } else {
    return res.status(404).send('Unknown module');
  }

  res.render('induction/admin/presenter', {
    layout: false,
    module,
    moduleTitle,
    slides,
    totalSlides: slides.length,
    title: moduleTitle,
  });
});

// GET /induction/admin/presentations — history of presentations
router.get('/presentations', (req, res) => {
  const presentations = getDb().prepare(`
    SELECT p.*, u.full_name as presenter_name
    FROM induction_presentations p
    LEFT JOIN users u ON p.presented_by_id = u.id
    ORDER BY p.started_at DESC
  `).all();

  res.render('induction/admin/presentations', {
    title: 'Training Presentations',
    currentPage: 'induction',
    presentations,
  });
});

// POST /induction/admin/present/:module/start — start a presentation session
router.post('/present/:module/start', (req, res) => {
  const { module } = req.params;
  const moduleKey = module === 'employee-guide' ? 'employee_guide' : module === 'tc-training-1' ? 'tc_training_1' : null;
  if (!moduleKey) return res.status(400).send('Invalid module');

  const slides = moduleKey === 'employee_guide' ? employeeGuideSlides : tcTrainingSlides;
  const { attendee_names } = req.body;

  const result = getDb().prepare(`
    INSERT INTO induction_presentations (module, presented_by_id, attendee_names, total_slides)
    VALUES (?, ?, ?, ?)
  `).run(moduleKey, req.session.user.id, attendee_names || '', slides.length);

  res.json({ id: result.lastInsertRowid });
});

// POST /induction/admin/present/:module/complete — mark presentation complete
router.post('/present/:module/complete', (req, res) => {
  const { presentation_id } = req.body;
  if (presentation_id) {
    getDb().prepare(`
      UPDATE induction_presentations SET completed_at = datetime('now') WHERE id = ?
    `).run(presentation_id);
  }
  res.json({ success: true });
});

module.exports = router;
