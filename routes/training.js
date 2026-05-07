const express = require('express');
const router = express.Router();
const { employeeGuideSlides, tcTrainingSlides } = require('../induction-slides');
const { getDb } = require('../db/database');

// Disable caching
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// One config object per public training module. Adding a new module is
// "drop in here, done" — the URL, slides, completion-record key, and
// display title all live in one place.
const MODULES = {
  'employee-guide': {
    slides: employeeGuideSlides,
    moduleTitle: 'T&S Employee Guide',
    moduleKey: 'employee_guide',
    modulePath: '/training/employee-guide',
  },
  'traffic-control': {
    slides: tcTrainingSlides,
    moduleTitle: 'Traffic Control — Training Module 1',
    moduleKey: 'tc_training_1',
    modulePath: '/training/traffic-control',
  },
};

// GET — standalone training pages (no login required)
router.get('/:slug', (req, res, next) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) return next();
  res.render('training/guide', {
    layout: false,
    slides: cfg.slides,
    totalSlides: cfg.slides.length,
    moduleTitle: cfg.moduleTitle,
    modulePath: cfg.modulePath,
    completionUrl: cfg.modulePath + '/complete',
  });
});

// POST — record quiz completion
router.post('/:slug/complete', express.json(), (req, res, next) => {
  const cfg = MODULES[req.params.slug];
  if (!cfg) return next();
  try {
    const db = getDb();
    const { full_name, email, score, total } = req.body;
    if (!full_name || !email || score == null || total == null) {
      return res.json({ success: false, error: 'Missing fields' });
    }

    const passed = Math.round((score / total) * 100) >= 90 ? 1 : 0;

    // Try to match email to an existing employee — same lookup as the
    // employee guide so completions show up on the employee's profile.
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
    `).run(employeeId, cfg.moduleKey, full_name.trim(), email.trim().toLowerCase(), score, total, passed);

    res.json({ success: true, linked });
  } catch (err) {
    console.error('[Training] Completion error:', err);
    res.json({ success: false, error: err.message });
  }
});

module.exports = router;
