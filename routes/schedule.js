const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
  const db = getDb();

  const jobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.suburb, j.status, j.start_date, j.end_date, j.percent_complete, j.health,
      u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status IN ('active', 'on_hold', 'won')
    AND j.start_date IS NOT NULL
    ORDER BY j.start_date ASC
  `).all();

  // Calculate date range for the timeline (1 month before today to 6 months after)
  const today = new Date();
  const rangeStart = req.query.from || new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split('T')[0];
  const rangeEnd = req.query.to || new Date(today.getFullYear(), today.getMonth() + 6, 0).toISOString().split('T')[0];

  res.render('schedule/index', {
    title: 'Job Schedule',
    currentPage: 'schedule',
    jobs,
    rangeStart,
    rangeEnd,
    today: today.toISOString().split('T')[0]
  });
});

module.exports = router;
