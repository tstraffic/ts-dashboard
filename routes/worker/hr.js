const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');

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

// Helper: format a Date using local Y-M-D (avoid toISOString timezone shift)
function localIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Helper: expand a set of options into a flat list of ISO date strings
function expandLeaveDates(body) {
  const out = new Set();
  // Plain array of dates (multi-select)
  if (Array.isArray(body.dates)) {
    body.dates.forEach(d => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d); });
  } else if (typeof body.dates === 'string' && body.dates.trim()) {
    // Comma-separated fallback
    body.dates.split(',').forEach(d => { d = d.trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d); });
  }

  // Recurring expansion
  const mode = body.mode; // 'single' | 'multiple' | 'recurring'
  if (mode === 'recurring' && body.recur_start && body.recur_until) {
    const [sy, sm, sd] = body.recur_start.split('-').map(Number);
    const [uy, um, ud] = body.recur_until.split('-').map(Number);
    const start = new Date(sy, sm - 1, sd);
    const until = new Date(uy, um - 1, ud);
    if (!isNaN(start) && !isNaN(until) && until >= start) {
      const freq = body.recur_freq || 'weekly'; // weekly | fortnightly | monthly
      const weekdays = []
        .concat(Array.isArray(body.recur_weekdays) ? body.recur_weekdays : body.recur_weekdays ? [body.recur_weekdays] : [])
        .map(x => parseInt(x, 10)).filter(x => !isNaN(x) && x >= 0 && x <= 6);
      let cursor = new Date(start);
      let safety = 0;
      while (cursor <= until && safety < 400) {
        safety++;
        if (freq === 'monthly') {
          out.add(localIso(cursor));
          cursor.setMonth(cursor.getMonth() + 1);
        } else {
          // weekly / fortnightly, with optional weekdays list
          if (weekdays.length > 0) {
            // Add each selected weekday within the current week window
            for (let i = 0; i < 7 && cursor <= until; i++) {
              const d = new Date(cursor); d.setDate(d.getDate() + i);
              if (d > until) break;
              if (weekdays.includes(d.getDay())) out.add(localIso(d));
            }
            cursor.setDate(cursor.getDate() + (freq === 'fortnightly' ? 14 : 7));
          } else {
            out.add(localIso(cursor));
            cursor.setDate(cursor.getDate() + (freq === 'fortnightly' ? 14 : 7));
          }
        }
      }
    }
  }

  // Also accept legacy start_date/end_date range (inclusive)
  if (body.start_date && body.end_date && !out.size) {
    const [sy, sm, sd] = body.start_date.split('-').map(Number);
    const [ey, em, ed] = body.end_date.split('-').map(Number);
    const s = new Date(sy, sm - 1, sd);
    const e = new Date(ey, em - 1, ed);
    if (!isNaN(s) && !isNaN(e) && e >= s) {
      const cur = new Date(s);
      let safety = 0;
      while (cur <= e && safety < 400) { out.add(localIso(cur)); cur.setDate(cur.getDate() + 1); safety++; }
    }
  }

  return Array.from(out).sort();
}

// GET /w/hr/leave — Calendar view of leave
router.get('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Month to display: ?m=YYYY-MM, default current month
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed
  const m = (req.query.m || '').match(/^(\d{4})-(\d{2})$/);
  if (m) { year = parseInt(m[1], 10); month = parseInt(m[2], 10) - 1; }

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthLabel = first.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);
  const pad = n => String(n).padStart(2, '0');
  const prevM = `${prevMonth.getFullYear()}-${pad(prevMonth.getMonth() + 1)}`;
  const nextM = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}`;

  // Build grid cells: pad to Monday-start week
  const cells = [];
  const firstWeekday = (first.getDay() + 6) % 7; // 0=Mon
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  // Load leave records overlapping the month
  const startIso = `${year}-${pad(month + 1)}-01`;
  const endIso = `${year}-${pad(month + 1)}-${pad(last.getDate())}`;
  const leaveRows = db.prepare(`
    SELECT * FROM employee_leave
    WHERE crew_member_id = ? AND status != 'cancelled'
      AND NOT (end_date < ? OR start_date > ?)
    ORDER BY start_date ASC
  `).all(worker.id, startIso, endIso);

  // Expand each row into per-date entries for the current month
  const byDate = {};
  for (const r of leaveRows) {
    const s = new Date(r.start_date + 'T00:00:00');
    const e = new Date(r.end_date + 'T00:00:00');
    for (const cell of cells) {
      if (!cell) continue;
      const cd = new Date(cell + 'T00:00:00');
      if (cd >= s && cd <= e) {
        if (!byDate[cell]) byDate[cell] = [];
        byDate[cell].push({ id: r.id, status: r.status, period: r.shift_period || 'full_day', type: r.leave_type, reason: r.reason });
      }
    }
  }

  // Also load ALL recent leave for history list
  const recentLeave = db.prepare('SELECT * FROM employee_leave WHERE crew_member_id = ? ORDER BY start_date DESC LIMIT 30').all(worker.id);

  res.render('worker/hr-leave', {
    title: 'Leave',
    currentPage: 'leave',
    cells,
    byDate,
    monthLabel,
    prevM,
    nextM,
    currentM: `${year}-${pad(month + 1)}`,
    todayIso: sydneyToday(),
    recentLeave,
  });
});

// POST /w/hr/leave — Submit leave (single/multiple/recurring)
router.post('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const leaveType = req.body.leave_type || 'annual';
  const shiftPeriod = ['day','night','full_day'].includes(req.body.shift_period) ? req.body.shift_period : 'full_day';
  const reason = req.body.reason || null;

  const dates = expandLeaveDates(req.body);
  if (dates.length === 0) {
    req.flash('error', 'Please select at least one date.');
    return res.redirect('/w/hr/leave');
  }

  // Cap at 180 dates as a safety
  const capped = dates.slice(0, 180);
  const employee = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  const empId = employee ? employee.id : null;

  const insert = db.prepare(`
    INSERT INTO employee_leave (employee_id, crew_member_id, leave_type, shift_period, start_date, end_date, total_days, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const d of capped) {
      insert.run(empId, worker.id, leaveType, shiftPeriod, d, d, shiftPeriod === 'full_day' ? 1 : 0.5, reason);
    }
  });
  try { tx(); } catch (e) {
    console.error('Leave insert failed:', e.message);
    req.flash('error', 'Could not save leave: ' + e.message);
    return res.redirect('/w/hr/leave');
  }

  req.flash('success', capped.length === 1 ? 'Leave submitted.' : `${capped.length} leave days submitted.`);
  res.redirect('/w/hr/leave');
});

// POST /w/hr/leave/:id/cancel — Cancel a leave record
router.post('/hr/leave/:id/cancel', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const record = db.prepare('SELECT * FROM employee_leave WHERE id = ? AND crew_member_id = ?').get(req.params.id, worker.id);
  if (!record) { req.flash('error', 'Leave not found.'); return res.redirect('/w/hr/leave'); }
  if (record.status === 'approved') {
    req.flash('error', 'Approved leave cannot be cancelled — contact your supervisor.');
    return res.redirect('/w/hr/leave');
  }
  db.prepare("UPDATE employee_leave SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  req.flash('success', 'Leave cancelled.');
  res.redirect('/w/hr/leave');
});

// ============================================
// PAYSLIPS
// ============================================
const path = require('path');
const fs = require('fs');
const PAYSLIP_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'payroll');

// Load the worker's linked employee id once per request. Returns null if the
// crew_member isn't linked to an employees row — which also means no payslips.
function loadLinkedEmployeeId(workerId) {
  const db = getDb();
  const linked = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(workerId);
  if (linked) return linked.id;
  const member = db.prepare('SELECT employee_id FROM crew_members WHERE id = ?').get(workerId);
  if (member && member.employee_id) {
    const byCode = db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(member.employee_id);
    if (byCode) return byCode.id;
  }
  return null;
}

// GET /w/hr/payslips — List the worker's own payslips
router.get('/hr/payslips', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) {
    return res.render('worker/hr-payslips', {
      title: 'Payslips', currentPage: 'more',
      payslips: [], summary: null, notLinked: true,
      flash_success: req.flash('success'), flash_error: req.flash('error'),
    });
  }
  const payslips = db.prepare(`
    SELECT * FROM payslips WHERE employee_id = ?
    ORDER BY pay_date DESC, id DESC LIMIT 100
  `).all(empId);
  const summary = db.prepare(`
    SELECT
      COALESCE(MAX(ytd_gross), 0) as ytd_gross,
      COALESCE(MAX(ytd_tax), 0) as ytd_tax,
      COALESCE(MAX(ytd_super), 0) as ytd_super,
      COALESCE(MAX(ytd_net), 0) as ytd_net,
      COUNT(*) as total
    FROM payslips WHERE employee_id = ?
  `).get(empId);
  res.render('worker/hr-payslips', {
    title: 'Payslips', currentPage: 'more',
    payslips, summary, notLinked: false,
    flash_success: req.flash('success'), flash_error: req.flash('error'),
  });
});

// GET /w/hr/payslips/:id — Download the worker's own payslip (auth-checked stream)
router.get('/hr/payslips/:id', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) return res.status(404).send('Not found');

  const p = db.prepare('SELECT * FROM payslips WHERE id = ? AND employee_id = ?').get(req.params.id, empId);
  if (!p || !p.pdf_filename) return res.status(404).send('Not found');

  const filePath = path.join(PAYSLIP_DIR, `emp_${p.employee_id}`, p.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  // First-view timestamp (for admin visibility) + always bump view_count
  try {
    if (!p.viewed_at) db.prepare("UPDATE payslips SET viewed_at = datetime('now'), view_count = view_count + 1 WHERE id = ?").run(p.id);
    else db.prepare("UPDATE payslips SET view_count = view_count + 1 WHERE id = ?").run(p.id);
  } catch (e) { /* audit-only */ }

  const downloadName = `Payslip_${p.pay_date}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
