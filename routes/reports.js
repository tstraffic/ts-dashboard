const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','completed') ORDER BY job_number`).all();

  res.render('reports/index', {
    title: 'Reports & Exports',
    currentPage: 'reports',
    jobs
  });
});

module.exports = router;
