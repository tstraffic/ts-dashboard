const express = require('express');
const router = express.Router();
const { employeeGuideSlides } = require('../induction-slides');
const { getDb } = require('../db/database');

// Disable caching
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// GET /training/employee-guide — standalone training page (no login required)
router.get('/employee-guide', (req, res) => {
  res.render('training/guide', {
    layout: false,
    slides: employeeGuideSlides,
    totalSlides: employeeGuideSlides.length,
    moduleTitle: 'T&S Employee Guide'
  });
});

// POST /training/employee-guide/complete — record quiz completion
router.post('/employee-guide/complete', express.json(), (req, res) => {
  try {
    const db = getDb();
    const { full_name, email, score, total } = req.body;
    if (!full_name || !email || score == null || total == null) {
      return res.json({ success: false, error: 'Missing fields' });
    }

    const passed = Math.round((score / total) * 100) >= 90 ? 1 : 0;

    // Try to match email to an existing employee
    let employeeId = null;
    let linked = false;
    const employee = db.prepare("SELECT id FROM employees WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL").get(email.trim());
    if (employee) {
      employeeId = employee.id;
      linked = true;
    }

    db.prepare(`
      INSERT INTO training_completions (employee_id, module, full_name, email, score, total, passed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(employeeId, 'employee_guide', full_name.trim(), email.trim().toLowerCase(), score, total, passed);

    res.json({ success: true, linked });
  } catch (err) {
    console.error('Training completion error:', err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
