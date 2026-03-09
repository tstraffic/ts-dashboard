const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');

// GET /w/jobs — My Jobs (today + upcoming 7 days)
router.get('/jobs', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = new Date().toISOString().split('T')[0];

  // Calculate date 7 days from now
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 7);
  const futureDateStr = futureDate.toISOString().split('T')[0];

  // Get all allocations for today + next 7 days
  const allocations = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date >= ? AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, today, futureDateStr);

  // Group by date
  const groupedByDate = {};
  allocations.forEach(a => {
    if (!groupedByDate[a.allocation_date]) {
      groupedByDate[a.allocation_date] = [];
    }
    groupedByDate[a.allocation_date].push(a);
  });

  res.render('worker/jobs', {
    title: 'My Jobs',
    currentPage: 'jobs',
    allocations,
    groupedByDate,
    today,
  });
});

// GET /w/jobs/:id — Job detail (allocation detail)
router.get('/jobs/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Get this allocation (must belong to this worker)
  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      j.notes as job_notes, j.start_date as job_start, j.end_date as job_end,
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
    // Check if supervisor is also a crew member with a phone
    const supCrew = db.prepare("SELECT phone FROM crew_members WHERE full_name = ? AND phone != ''").get(allocation.supervisor_name);
    if (supCrew) supervisorPhone = supCrew.phone;
  }

  res.render('worker/job-detail', {
    title: allocation.job_name || allocation.job_number,
    currentPage: 'jobs',
    allocation,
    otherCrew,
    supervisorPhone,
  });
});

module.exports = router;
