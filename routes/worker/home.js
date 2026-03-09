const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { getComplianceStatus } = require('../../middleware/compliance');

// GET /w/home — Worker home screen
router.get('/home', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];

  // Get today's allocation(s) for this worker
  const todaysShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      u.full_name as supervisor_name, u.email as supervisor_email
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC
  `).all(worker.id, today);

  // Get supervisor phone from crew_members if they are also a crew member (or from job supervisor)
  // For now we use the ops_supervisor from the job
  todaysShifts.forEach(shift => {
    // Try to get supervisor's phone from users table
    if (shift.supervisor_name) {
      const supUser = db.prepare('SELECT email FROM users WHERE full_name = ?').get(shift.supervisor_name);
      shift.supervisor_contact = supUser ? supUser.email : '';
    }
  });

  // Get the crew member record for compliance check
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);
  const compliance = member ? getComplianceStatus(member, today) : null;

  // Get time-based greeting
  const hour = new Date().getHours();
  let greeting;
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';

  const firstName = worker.full_name.split(' ')[0];

  res.render('worker/home', {
    title: 'Home',
    currentPage: 'home',
    greeting,
    firstName,
    todaysShifts,
    compliance,
    member,
    today,
  });
});

module.exports = router;
