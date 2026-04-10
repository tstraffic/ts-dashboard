const express = require('express');
const router = express.Router();
const { employeeGuideSlides } = require('../induction-slides');

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

module.exports = router;
