// Full Checklist Register page. Mirrors the office's manual spreadsheet
// (year heading → month heading → week rows → 5 form-type rows each).

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const register = require('../services/checklistRegister');

// GET /checklist-register?year=YYYY&month=MM
// Defaults to the current month. Render the month roll-up + each week's table.
router.get('/', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = req.query.year ? Math.max(2024, Math.min(2100, Number(req.query.year))) : now.getFullYear();
  const month = req.query.month ? Math.max(1, Math.min(12, Number(req.query.month))) : (now.getMonth() + 1);
  const monthData = register.registerForMonth(db, year, month - 1);

  // Months selectable: the current month + 11 prior, so the office can
  // page back through history without typing dates.
  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) });
  }

  res.render('checklist-register', {
    title: 'Checklist Register',
    year,
    month,
    monthLabel: new Date(year, month - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
    monthData,
    months,
  });
});

module.exports = router;
