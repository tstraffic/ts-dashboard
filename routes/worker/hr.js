const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/hr — HR hub
router.get('/hr', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Find linked employee record
  const employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);

  // Get certifications count
  let certs = [];
  let expiringSoon = 0;
  if (employee) {
    certs = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);
    const thirtyDays = new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    expiringSoon = certs.filter(c => c.expiry_date && new Date(c.expiry_date) <= thirtyDays && new Date(c.expiry_date) >= new Date()).length;
  }

  // Get leave requests
  const leaveRequests = db.prepare('SELECT * FROM employee_leave WHERE crew_member_id = ? ORDER BY created_at DESC LIMIT 10').all(worker.id);
  const pendingLeave = leaveRequests.filter(l => l.status === 'pending').length;

  // Get crew member details
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);

  res.render('worker/hr', {
    title: 'HR & My Info',
    currentPage: 'more',
    employee,
    member,
    certs,
    expiringSoon,
    leaveRequests,
    pendingLeave,
  });
});

// GET /w/hr/certs — My Certifications
router.get('/hr/certs', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);

  let certs = [];
  if (employee) {
    certs = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);
  }

  // Also get crew_member licence info
  const member = db.prepare('SELECT licence_type, licence_expiry, induction_date FROM crew_members WHERE id = ?').get(worker.id);

  res.render('worker/hr-certs', {
    title: 'My Certifications',
    currentPage: 'more',
    certs,
    member,
  });
});

// GET /w/hr/leave — Leave requests
router.get('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const leaveRequests = db.prepare('SELECT * FROM employee_leave WHERE crew_member_id = ? ORDER BY start_date DESC LIMIT 30').all(worker.id);

  res.render('worker/hr-leave', {
    title: 'Leave Requests',
    currentPage: 'more',
    leaveRequests,
  });
});

// POST /w/hr/leave — Submit leave request
router.post('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { leave_type, start_date, end_date, reason } = req.body;

  if (!start_date || !end_date) {
    req.flash('error', 'Please provide start and end dates.');
    return res.redirect('/w/hr/leave');
  }

  // Calculate days
  const start = new Date(start_date);
  const end = new Date(end_date);
  const diffMs = end - start;
  const totalDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);

  // Find employee record
  const employee = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(worker.id);

  db.prepare(`
    INSERT INTO employee_leave (employee_id, crew_member_id, leave_type, start_date, end_date, total_days, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(employee ? employee.id : null, worker.id, leave_type || 'annual', start_date, end_date, totalDays, reason || null);

  req.flash('success', 'Leave request submitted.');
  res.redirect('/w/hr/leave');
});

module.exports = router;
