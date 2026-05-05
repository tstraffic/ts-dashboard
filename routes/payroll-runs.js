// /payroll/runs — weekly pay runs imported from a Traffio Person Dockets CSV.
// Each pay run breaks workers into Cash / TFN / ABN sections with up to 8
// hour buckets per worker (day_normal/day_ot/day_dt, night_normal/night_ot/
// night_dt, weekend, public_holiday). Rates + classifications snapshot at
// import time so historical runs are immutable.

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');

const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const {
  parseCsv, normalizeShift, aggregateByWorker, inferPeriod,
  matchEmployee, fetchClassification,
  buildLine, recomputeLine, recategorizeFromShifts, computeAutoAllowances,
  resolveRates, totalsFromBuckets, emptyBuckets,
  formatLocalDate, safeParseJson,
  BUCKETS, BUCKET_LABELS, BUCKET_RATE_FIELDS,
  round2, toNum,
} = require('../lib/payroll');

// ----------------------------------------------------------------------------
// Upload setup
// ----------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'payroll-csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.csv') || '.csv').toLowerCase();
      cb(null, `payrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.csv$/i.test(file.originalname || '');
    const okMime = /text|csv|excel|octet-stream/i.test(file.mimetype || '');
    if (!okExt && !okMime) return cb(new Error('CSV files only'));
    cb(null, true);
  },
});

const SECTIONS = [
  { key: 'cash', label: 'Cash', accent: 'amber',   buckets: ['day_normal', 'night_normal'] },
  { key: 'tfn',  label: 'TFN',  accent: 'emerald', buckets: BUCKETS },
  { key: 'abn',  label: 'ABN',  accent: 'sky',     buckets: ['day_normal', 'day_ot', 'night_normal', 'night_ot', 'weekend'] },
];
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function periodLabel(start, end) {
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `WE ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}

function loadPHSet(db) {
  const rows = db.prepare('SELECT date FROM public_holidays').all();
  return new Set(rows.map(r => r.date));
}
function makeIsPH(phSet) { return (date) => phSet.has(date); }

function hydrateLine(line) {
  line.buckets = safeParseJson(line.buckets_json, null);
  if (!line.buckets) {
    // Old line missing buckets — synthesize from legacy day/night
    const day = safeParseJson(line.day_hours_json, [0,0,0,0,0,0,0]);
    const night = safeParseJson(line.night_hours_json, [0,0,0,0,0,0,0]);
    line.buckets = emptyBuckets({ day_normal: line.rate_day, night_normal: line.rate_night });
    line.buckets.day_normal.hours = day;
    line.buckets.day_normal.total_hours = line.total_day_hours || 0;
    line.buckets.day_normal.total_wages = line.total_day_wages || 0;
    line.buckets.night_normal.hours = night;
    line.buckets.night_normal.total_hours = line.total_night_hours || 0;
    line.buckets.night_normal.total_wages = line.total_night_wages || 0;
  }
  line.shifts = safeParseJson(line.shifts_json, []);
  return line;
}

// Creates a Management pay run + auto-seeds one Salary line per employee
// flagged with on_management_payroll. Used by POST /runs when the form
// posts pay_run_type=management.
function createManagementRun(req, res) {
  try {
    const db = getDb();
    const period_start = (req.body.period_start || '').trim();
    const period_end = (req.body.period_end || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end)) {
      req.flash('error', 'Period start + end dates are required (YYYY-MM-DD).');
      return res.redirect('/payroll/runs/new?type=management');
    }
    const label = (req.body.label || '').trim() || ('Management — ' + periodLabel(period_start, period_end));
    const notes = (req.body.notes || '').trim();

    let runId;
    let seeded = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes, pay_run_type)
        VALUES (?, ?, ?, '', 'draft', ?, ?, 'management')
      `).run(period_start, period_end, label, req.session.user.id, notes);
      runId = r.lastInsertRowid;

      const staff = db.prepare(`
        SELECT id, employee_code, first_name, last_name, payment_type,
          COALESCE(weekly_salary, 0) AS weekly_salary,
          COALESCE(super_rate, 0.115) AS super_rate,
          COALESCE(payroll_bsb, '') AS payroll_bsb,
          COALESCE(payroll_account, '') AS payroll_account
        FROM employees
        WHERE on_management_payroll = 1 AND deleted_at IS NULL
        ORDER BY LOWER(first_name), LOWER(last_name)
      `).all();

      const insertLine = db.prepare(`
        INSERT INTO pay_run_lines (
          pay_run_id, employee_id, full_name, payment_type, bsb, acc_number,
          salary_amount, super_amount, income_label,
          total_wages, grand_total, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Salary', ?, ?, ?)
      `);
      let order = 0;
      for (const e of staff) {
        const fullName = ((e.first_name || '') + ' ' + (e.last_name || '')).trim() || ('Employee #' + e.id);
        const salary = round2(toNum(e.weekly_salary));
        const superAmt = round2(salary * toNum(e.super_rate));
        insertLine.run(
          runId, e.id, fullName, e.payment_type || '',
          e.payroll_bsb, e.payroll_account,
          salary, superAmt,
          salary, salary,   // total_wages and grand_total mirror salary for management lines
          order++,
        );
        seeded++;
      }
    });
    tx();

    try {
      logActivity({
        user: req.session.user, action: 'create', entityType: 'pay_run',
        entityId: runId, entityLabel: label,
        details: `Created Management pay run — ${seeded} starter line(s)`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block */ }

    req.flash('success', seeded > 0
      ? `Created Management pay run with ${seeded} starter line(s).`
      : 'Created Management pay run. No staff are flagged for management payroll yet — tick "On management payroll" on an employee record to populate it.');
    return res.redirect('/payroll/runs/' + runId);
  } catch (err) {
    console.error('[payroll/runs] createManagementRun:', err);
    req.flash('error', 'Failed to create Management pay run: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/new?type=management');
  }
}

function sectionTotal(arr) {
  let hours = 0, wages = 0, allow = 0, total = 0;
  for (const l of arr) {
    hours += toNum(l.total_hours);
    wages += toNum(l.total_wages);
    allow += toNum(l.total_allowance);
    total += toNum(l.grand_total);
  }
  return {
    hours: round2(hours), wages: round2(wages), allow: round2(allow), total: round2(total),
    gst: round2(total * 0.10), with_gst: round2(total * 1.10),
  };
}

// ============================================================================
// GET /payroll/runs — list
// ============================================================================
router.get('/runs', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const VALID_TYPES = ['traffic_control', 'management'];
  const typeFilter = VALID_TYPES.includes(req.query.type) ? req.query.type : null;

  let where = '1=1';
  const params = [];
  if (typeFilter) { where += ' AND COALESCE(pr.pay_run_type, \'traffic_control\') = ?'; params.push(typeFilter); }

  const runs = db.prepare(`
    SELECT pr.*, u.full_name AS created_by_name,
      COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id) AS line_count,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id) AS grand_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'cash') AS cash_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'tfn') AS tfn_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'abn') AS abn_total,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND COALESCE(payment_type, '') = '') AS unclassified_count,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND paid = 1) AS paid_count
    FROM pay_runs pr
    LEFT JOIN users u ON u.id = pr.created_by_id
    WHERE ${where}
    ORDER BY pr.period_end DESC, pr.id DESC
    LIMIT 200
  `).all(...params);

  // Per-type counts for the tab badges (computed independent of the filter)
  const counts = db.prepare(`
    SELECT COALESCE(pay_run_type, 'traffic_control') AS t, COUNT(*) AS n
    FROM pay_runs GROUP BY 1
  `).all().reduce((acc, r) => { acc[r.t] = r.n; return acc; }, {});

  res.render('payroll-runs/index', {
    title: 'Pay Runs',
    currentPage: 'pay-runs',
    runs, fmtMoney, periodLabel,
    typeFilter,
    counts: { traffic_control: counts.traffic_control || 0, management: counts.management || 0 },
  });
});

// ============================================================================
// GET /payroll/runs/new
// Renders a type picker. Management runs skip CSV; TC runs upload it.
// ============================================================================
router.get('/runs/new', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  // Show how many staff would be auto-pre-filled if they pick Management
  let mgmtCount = 0;
  try { mgmtCount = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE on_management_payroll = 1 AND deleted_at IS NULL").get().c; } catch (e) {}
  res.render('payroll-runs/new', {
    title: 'New Pay Run',
    currentPage: 'pay-runs',
    runType: req.query.type === 'management' ? 'management' : 'traffic_control',
    mgmtCount,
  });
});

// ============================================================================
// POST /payroll/runs — branch on pay_run_type
//   - 'management': create the parent row + auto-seed one Salary line per
//     employee with on_management_payroll = 1.
//   - default ('traffic_control'): existing CSV import path.
// ============================================================================
router.post('/runs', requirePermission('payroll'), (req, res) => {
  // Management branch: no CSV, just period dates. Detect via the
  // pay_run_type form field. multipart/form-data isn't required, so
  // we sniff before invoking multer.
  const requestedType = (req.body && req.body.pay_run_type) || '';
  if (requestedType === 'management') {
    return createManagementRun(req, res);
  }
  upload.single('csv')(req, res, function (err) {
    if (err) { req.flash('error', err.message); return res.redirect('/payroll/runs/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/payroll/runs/new'); }

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/payroll/runs/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      req.flash('error', 'CSV had no data rows.');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    const shifts = rows.map(normalizeShift).filter(Boolean);
    if (shifts.length === 0) {
      req.flash('error', 'CSV had no usable shifts.');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    const inferred = inferPeriod(shifts);
    const period_start = (req.body.period_start && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_start))
      ? req.body.period_start : inferred.period_start;
    const period_end = (req.body.period_end && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_end))
      ? req.body.period_end : inferred.period_end;
    const label = (req.body.label || '').trim() || periodLabel(period_start, period_end);
    const notes = (req.body.notes || '').trim();

    const workers = aggregateByWorker(shifts);
    const db = getDb();
    const isPH = makeIsPH(loadPHSet(db));

    let runId;
    try {
      const insertRun = db.prepare(`
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes, pay_run_type)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, 'traffic_control')
      `);
      const insertLine = db.prepare(`
        INSERT INTO pay_run_lines (
          pay_run_id, employee_id, person_id, full_name, payment_type, bsb, acc_number,
          buckets_json, day_hours_json, night_hours_json,
          total_day_hours, total_night_hours, total_hours,
          rate_day, rate_night,
          total_day_wages, total_night_wages, total_wages,
          travel_allowance, meal_allowance, other_allowance, total_allowance,
          grand_total, paid, paid_ref, paid_at, notes, shifts_json, sort_order
        ) VALUES (
          @pay_run_id, @employee_id, @person_id, @full_name, @payment_type, @bsb, @acc_number,
          @buckets_json, @day_hours_json, @night_hours_json,
          @total_day_hours, @total_night_hours, @total_hours,
          @rate_day, @rate_night,
          @total_day_wages, @total_night_wages, @total_wages,
          @travel_allowance, @meal_allowance, @other_allowance, @total_allowance,
          @grand_total, @paid, @paid_ref, @paid_at, @notes, @shifts_json, @sort_order
        )
      `);

      const tx = db.transaction(() => {
        const r = insertRun.run(period_start, period_end, label, req.file.filename, req.session.user.id, notes);
        runId = r.lastInsertRowid;
        let order = 0;
        for (const agg of workers) {
          const employee = matchEmployee(db, agg);
          const classification = (employee && employee.award_classification_id)
            ? fetchClassification(db, employee.award_classification_id) : null;
          const line = buildLine({ pay_run_id: runId, agg, employee, classification, isPH });
          line.sort_order = order++;
          insertLine.run(line);
        }
      });
      tx();
    } catch (e) {
      console.error('Pay run import failed:', e);
      req.flash('error', 'Import failed: ' + e.message);
      try { fs.unlinkSync(req.file.path); } catch (er) {}
      return res.redirect('/payroll/runs/new');
    }

    logActivity({
      user: req.session.user, action: 'create', entityType: 'pay_run',
      entityId: runId, entityLabel: label,
      details: `Imported pay run ${label} — ${workers.length} workers, ${shifts.length} shifts`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${workers.length} workers from ${shifts.length} shifts.`);
    res.redirect('/payroll/runs/' + runId);
  });
});

// ============================================================================
// GET /payroll/runs/:id — main detail page. Branches view on pay_run_type.
// ============================================================================
router.get('/runs/:id', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  run.pay_run_type = run.pay_run_type || 'traffic_control';

  // Management runs use a salary-grid view: one row per income line,
  // grouped by employee, with inline-editable salary/super.
  if (run.pay_run_type === 'management') {
    const lines = db.prepare(`
      SELECT prl.*, e.employee_code, e.first_name, e.last_name,
        COALESCE(e.weekly_salary, 0) AS emp_weekly_salary,
        COALESCE(e.super_rate, 0.115) AS emp_super_rate
      FROM pay_run_lines prl
      LEFT JOIN employees e ON e.id = prl.employee_id
      WHERE prl.pay_run_id = ?
      ORDER BY LOWER(prl.full_name) ASC, prl.id ASC
    `).all(run.id);

    // All on-management staff, so the "+ Add line" picker has every
    // option even if a particular run hasn't seeded a row for them yet.
    const eligibleStaff = db.prepare(`
      SELECT id, first_name, last_name, employee_code,
        COALESCE(weekly_salary, 0) AS weekly_salary,
        COALESCE(super_rate, 0.115) AS super_rate
      FROM employees
      WHERE on_management_payroll = 1 AND deleted_at IS NULL
      ORDER BY LOWER(first_name), LOWER(last_name)
    `).all();

    let totalSalary = 0, totalSuper = 0;
    for (const l of lines) { totalSalary += toNum(l.salary_amount); totalSuper += toNum(l.super_amount); }
    return res.render('payroll-runs/management-show', {
      title: run.label || 'Management Pay Run',
      currentPage: 'pay-runs',
      run, lines, eligibleStaff,
      totals: { salary: round2(totalSalary), super: round2(totalSuper), grand: round2(totalSalary + totalSuper) },
      fmtMoney, periodLabel,
    });
  }

  const lines = db.prepare(`
    SELECT prl.*, e.employee_code, e.payment_type AS emp_payment_type,
      e.award_classification_id,
      ac.classification AS classification_name
    FROM pay_run_lines prl
    LEFT JOIN employees e ON e.id = prl.employee_id
    LEFT JOIN award_classifications ac ON ac.id = e.award_classification_id
    WHERE prl.pay_run_id = ?
    ORDER BY LOWER(prl.full_name) ASC
  `).all(run.id);

  const buckets = { cash: [], tfn: [], abn: [], unclassified: [] };
  for (const l of lines) {
    hydrateLine(l);
    const t = (l.payment_type || '').toLowerCase();
    if      (t === 'cash') buckets.cash.push(l);
    else if (t === 'tfn')  buckets.tfn.push(l);
    else if (t === 'abn')  buckets.abn.push(l);
    else                    buckets.unclassified.push(l);
  }

  const totals = {
    cash:         sectionTotal(buckets.cash),
    tfn:          sectionTotal(buckets.tfn),
    abn:          sectionTotal(buckets.abn),
    unclassified: sectionTotal(buckets.unclassified),
  };
  const grand = {
    total: round2(totals.cash.total + totals.tfn.total + totals.abn.total + totals.unclassified.total),
    paid:  round2(lines.filter(l => l.paid).reduce((s, l) => s + toNum(l.grand_total), 0)),
    paid_count: lines.filter(l => l.paid).length,
    line_count: lines.length,
  };

  const employees = db.prepare(`
    SELECT id, employee_code, full_name, payment_type
    FROM employees WHERE active = 1 ORDER BY LOWER(full_name) ASC
  `).all();

  res.render('payroll-runs/show', {
    title: run.label || periodLabel(run.period_start, run.period_end),
    currentPage: 'pay-runs',
    run,
    sections: SECTIONS,
    dowLabels: DOW_LABELS,
    bucketLabels: BUCKET_LABELS,
    bucketKeys: BUCKETS,
    buckets, totals, grand, employees,
    fmtMoney, periodLabel,
  });
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId — update a line
//   - If payment_type changes → re-categorize from shifts_json
//   - Else if `buckets[]` is present → use those edits
//   - Always recompute totals + apply allowance edits
// ============================================================================
router.post('/runs/:id/lines/:lineId', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Pay run not found' });
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, run.id);
  if (!line) return res.status(404).json({ error: 'Line not found' });

  const b = req.body || {};
  const updates = {};

  // Payment type
  let newPT = line.payment_type || '';
  let ptChanged = false;
  if (b.payment_type !== undefined) {
    const pt = String(b.payment_type || '').toLowerCase();
    newPT = ['cash', 'tfn', 'abn'].includes(pt) ? pt : '';
    if (newPT !== (line.payment_type || '')) {
      ptChanged = true;
      updates.payment_type = newPT;
    }
  }

  // BSB / Account
  if (b.bsb !== undefined)        updates.bsb = String(b.bsb || '').trim();
  if (b.acc_number !== undefined) updates.acc_number = String(b.acc_number || '').trim();

  // Allowances
  if (b.travel_allowance !== undefined) updates.travel_allowance = toNum(b.travel_allowance);
  if (b.meal_allowance   !== undefined) updates.meal_allowance   = toNum(b.meal_allowance);
  if (b.other_allowance  !== undefined) updates.other_allowance  = toNum(b.other_allowance);

  // Paid
  if (b.paid !== undefined) {
    const paidNow = (b.paid === true || b.paid === '1' || b.paid === 1 || b.paid === 'true' || b.paid === 'on') ? 1 : 0;
    updates.paid = paidNow;
    if (paidNow && !line.paid_at) updates.paid_at = new Date().toISOString();
    if (!paidNow) updates.paid_at = null;
  }
  if (b.paid_ref !== undefined) updates.paid_ref = String(b.paid_ref || '').trim();
  if (b.notes !== undefined)    updates.notes    = String(b.notes || '').trim();

  // Resolve buckets — three paths
  const isPH = makeIsPH(loadPHSet(db));
  let bucketsState = null;

  if (ptChanged) {
    // Re-categorize from shifts_json with new section's rules + employee/classification rates
    const employee = line.employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(line.employee_id) : null;
    const classification = (employee && employee.award_classification_id)
      ? fetchClassification(db, employee.award_classification_id) : null;
    const { buckets, auto } = recategorizeFromShifts(line, { paymentType: newPT, employee, classification, isPH });
    bucketsState = buckets;
    if (b.travel_allowance === undefined) updates.travel_allowance = auto.travel;
    if (b.meal_allowance   === undefined) updates.meal_allowance   = auto.meal;
  } else if (b.buckets && typeof b.buckets === 'object') {
    // Manual bucket edits — accept hours[7] + rate per bucket
    bucketsState = safeParseJson(line.buckets_json, null) || emptyBuckets({});
    for (const k of BUCKETS) {
      if (!bucketsState[k]) bucketsState[k] = { hours: [0,0,0,0,0,0,0], total_hours: 0, rate: 0, total_wages: 0 };
      const bk = b.buckets[k];
      if (!bk) continue;
      if (Array.isArray(bk.hours) && bk.hours.length === 7) {
        bucketsState[k].hours = bk.hours.map(toNum).map(round2);
      }
      if (bk.rate !== undefined) bucketsState[k].rate = toNum(bk.rate);
    }
  } else {
    // No bucket changes, no section change — keep existing
    bucketsState = safeParseJson(line.buckets_json, null);
  }

  if (bucketsState) updates.buckets_json = JSON.stringify(bucketsState);

  // Merge & recompute totals (uses buckets_json + travel/meal/other from updates+line)
  const merged = Object.assign({}, line, updates);
  const recomputed = recomputeLine(merged, { isPH });
  Object.assign(updates, recomputed);
  updates.updated_at = new Date().toISOString();

  // Optionally save back to the employee record
  if (line.employee_id) {
    const empUpdates = [];
    const empParams = [];
    if (b.save_bsb_to_employee) {
      if (updates.bsb !== undefined)        { empUpdates.push('payroll_bsb = ?');     empParams.push(updates.bsb); }
      if (updates.acc_number !== undefined) { empUpdates.push('payroll_account = ?'); empParams.push(updates.acc_number); }
    }
    if (b.save_payment_type_to_employee && updates.payment_type !== undefined) {
      empUpdates.push('payment_type = ?'); empParams.push(updates.payment_type);
    }
    if (empUpdates.length > 0) {
      empParams.push(line.employee_id);
      db.prepare(`UPDATE employees SET ${empUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...empParams);
    }
  }

  // Apply UPDATE
  const cols = Object.keys(updates);
  if (cols.length > 0) {
    const setSql = cols.map(c => `${c} = ?`).join(', ');
    const params = cols.map(c => updates[c]);
    params.push(req.params.lineId);
    db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
  }

  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    const fresh = db.prepare('SELECT * FROM pay_run_lines WHERE id = ?').get(req.params.lineId);
    return res.json({ ok: true, line: hydrateLine(fresh) });
  }
  return res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId/match — link to employee + recategorize
// ============================================================================
router.post('/runs/:id/lines/:lineId/match', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
  if (!line) { req.flash('error', 'Line not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const empId = parseInt(req.body.employee_id, 10);
  if (!empId) { req.flash('error', 'Pick an employee'); return res.redirect('/payroll/runs/' + req.params.id); }
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (!emp) { req.flash('error', 'Employee not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const newPT = (emp.payment_type && ['cash', 'tfn', 'abn'].includes(String(emp.payment_type).toLowerCase()))
    ? String(emp.payment_type).toLowerCase() : (line.payment_type || '');
  const classification = emp.award_classification_id ? fetchClassification(db, emp.award_classification_id) : null;
  const isPH = makeIsPH(loadPHSet(db));
  const { buckets, auto } = recategorizeFromShifts(line, { paymentType: newPT, employee: emp, classification, isPH });

  const updates = {
    employee_id: emp.id,
    payment_type: newPT,
    bsb: line.bsb || (emp.payroll_bsb || ''),
    acc_number: line.acc_number || (emp.payroll_account || ''),
    buckets_json: JSON.stringify(buckets),
    travel_allowance: auto.travel,
    meal_allowance: auto.meal,
    updated_at: new Date().toISOString(),
  };
  const merged = Object.assign({}, line, updates);
  const recomputed = recomputeLine(merged, { isPH });
  Object.assign(updates, recomputed);

  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]);
  params.push(line.id);
  db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);

  req.flash('success', `Linked ${line.full_name} → ${emp.full_name}.`);
  res.redirect('/payroll/runs/' + req.params.id);
});

// ============================================================================
// POST /payroll/runs/:id/refresh — re-categorize ALL lines from shifts_json
//   Useful after editing rates / classifications / public holidays.
// ============================================================================
router.post('/runs/:id/refresh', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }

  const isPH = makeIsPH(loadPHSet(db));
  const lines = db.prepare('SELECT * FROM pay_run_lines WHERE pay_run_id = ?').all(run.id);

  const tx = db.transaction(() => {
    let n = 0;
    for (const line of lines) {
      const employee = line.employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(line.employee_id) : null;
      const classification = (employee && employee.award_classification_id)
        ? fetchClassification(db, employee.award_classification_id) : null;
      const { buckets, auto } = recategorizeFromShifts(line, {
        paymentType: line.payment_type || '', employee, classification, isPH,
      });
      const updates = {
        buckets_json: JSON.stringify(buckets),
        travel_allowance: auto.travel,
        meal_allowance:   auto.meal,
        bsb: employee ? (employee.payroll_bsb || line.bsb || '') : line.bsb,
        acc_number: employee ? (employee.payroll_account || line.acc_number || '') : line.acc_number,
        updated_at: new Date().toISOString(),
      };
      const merged = Object.assign({}, line, updates);
      const recomputed = recomputeLine(merged, { isPH });
      Object.assign(updates, recomputed);
      const cols = Object.keys(updates);
      const setSql = cols.map(c => `${c} = ?`).join(', ');
      const params = cols.map(c => updates[c]);
      params.push(line.id);
      db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
      n++;
    }
    return n;
  });
  const n = tx();

  req.flash('success', `Refreshed ${n} lines from current rates and classifications.`);
  res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// Management pay run line endpoints — separate from the TC line editor
// because the column shape is different (salary/super/income_label vs
// hours buckets) and we want the cleaner per-row try/catch pattern.
// ============================================================================

// Loads a line and confirms it lives on a Management run.
function getManagementLine(db, runId, lineId) {
  return db.prepare(`
    SELECT prl.*, COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type
    FROM pay_run_lines prl
    JOIN pay_runs pr ON pr.id = prl.pay_run_id
    WHERE prl.pay_run_id = ? AND prl.id = ? AND COALESCE(pr.pay_run_type, 'traffic_control') = 'management'
  `).get(runId, lineId);
}

// POST /payroll/runs/:id/management-lines — add a new income line to a Management run.
router.post('/runs/:id/management-lines', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = db.prepare("SELECT id, COALESCE(pay_run_type, 'traffic_control') AS pay_run_type FROM pay_runs WHERE id = ?").get(req.params.id);
    if (!run || run.pay_run_type !== 'management') {
      req.flash('error', 'Management pay run not found.');
      return res.redirect('/payroll/runs');
    }
    const empId = parseInt(req.body.employee_id, 10);
    if (!empId) {
      req.flash('error', 'Employee is required.');
      return res.redirect('/payroll/runs/' + run.id);
    }
    const emp = db.prepare(`
      SELECT id, first_name, last_name, payment_type,
        COALESCE(weekly_salary, 0) AS weekly_salary,
        COALESCE(super_rate, 0.115) AS super_rate,
        COALESCE(payroll_bsb, '') AS payroll_bsb,
        COALESCE(payroll_account, '') AS payroll_account
      FROM employees WHERE id = ?
    `).get(empId);
    if (!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/payroll/runs/' + run.id);
    }
    const incomeLabel = String(req.body.income_label || 'Salary').trim().slice(0, 80) || 'Salary';
    const salary = round2(toNum(req.body.salary_amount));
    // If super amount blank, default to salary × employee's super_rate
    const superAmt = req.body.super_amount === '' || req.body.super_amount == null
      ? round2(salary * toNum(emp.super_rate))
      : round2(toNum(req.body.super_amount));
    const fullName = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim() || ('Employee #' + emp.id);

    db.prepare(`
      INSERT INTO pay_run_lines (
        pay_run_id, employee_id, full_name, payment_type, bsb, acc_number,
        salary_amount, super_amount, income_label,
        total_wages, grand_total, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, emp.id, fullName, emp.payment_type || '',
      emp.payroll_bsb, emp.payroll_account,
      salary, superAmt, incomeLabel,
      salary, salary,
      999);

    req.flash('success', `Added "${incomeLabel}" line for ${fullName}.`);
    return res.redirect('/payroll/runs/' + run.id);
  } catch (err) {
    console.error('[payroll/runs] add management line:', err);
    req.flash('error', 'Failed to add line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// POST /payroll/runs/:id/management-lines/:lineId — edit a single line.
// Accepts partial body: any of income_label, salary_amount, super_amount.
router.post('/runs/:id/management-lines/:lineId', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const line = getManagementLine(db, req.params.id, req.params.lineId);
    if (!line) {
      if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Line not found' });
      req.flash('error', 'Management pay run line not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const incomeLabel = req.body.income_label != null ? String(req.body.income_label).trim().slice(0, 80) : line.income_label;
    const salary = req.body.salary_amount != null ? round2(toNum(req.body.salary_amount)) : toNum(line.salary_amount);
    const superAmt = req.body.super_amount != null ? round2(toNum(req.body.super_amount)) : toNum(line.super_amount);
    db.prepare(`
      UPDATE pay_run_lines
      SET income_label = ?, salary_amount = ?, super_amount = ?,
          total_wages = ?, grand_total = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(incomeLabel, salary, superAmt, salary, salary, line.id);
    if (req.headers.accept && req.headers.accept.includes('json')) {
      return res.json({ success: true, income_label: incomeLabel, salary_amount: salary, super_amount: superAmt });
    }
    req.flash('success', 'Line updated.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[payroll/runs] edit management line:', err);
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Failed to update line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// POST /payroll/runs/:id/management-lines/:lineId/delete — drop a line.
router.post('/runs/:id/management-lines/:lineId/delete', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const line = getManagementLine(db, req.params.id, req.params.lineId);
    if (!line) {
      req.flash('error', 'Management pay run line not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    db.prepare('DELETE FROM pay_run_lines WHERE id = ?').run(line.id);
    req.flash('success', `Removed "${line.income_label || 'line'}" for ${line.full_name}.`);
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[payroll/runs] delete management line:', err);
    req.flash('error', 'Failed to delete line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// ============================================================================
// POST /payroll/runs/:id/delete
// ============================================================================
router.post('/runs/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found'); return res.redirect('/payroll/runs'); }
  db.prepare('DELETE FROM pay_runs WHERE id = ?').run(run.id);
  if (run.csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, run.csv_filename)); } catch (e) {}
  }
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Deleted pay run ${run.label}`,
    ip: req.ip,
  });
  req.flash('success', `Pay run ${run.label} removed.`);
  res.redirect('/payroll/runs');
});

// ============================================================================
// GET /payroll/runs/:id/export.xlsx
// ============================================================================
router.get('/runs/:id/export.xlsx', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).send('Pay run not found');

  const lines = db.prepare(`
    SELECT * FROM pay_run_lines WHERE pay_run_id = ?
    ORDER BY payment_type ASC, LOWER(full_name) ASC
  `).all(run.id);
  for (const l of lines) hydrateLine(l);

  const sectionData = SECTIONS.map(s => ({
    name: s.label, key: s.key, accent: s.accent, bucketKeys: s.buckets, gst: s.key === 'cash',
    lines: lines.filter(l => l.payment_type === s.key),
  }));

  const filename = `PayRun_${(run.label || periodLabel(run.period_start, run.period_end)).replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('xlsx archive error:', err); try { res.end(); } catch (e) {} });
  archive.pipe(res);

  archive.append(buildContentTypes(sectionData), { name: '[Content_Types].xml' });
  archive.append(buildRels(), { name: '_rels/.rels' });
  archive.append(buildWorkbook(sectionData), { name: 'xl/workbook.xml' });
  archive.append(buildWorkbookRels(sectionData), { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(buildStyles(), { name: 'xl/styles.xml' });
  sectionData.forEach((s, idx) => {
    archive.append(buildSheetXml(s, run), { name: `xl/worksheets/sheet${idx + 1}.xml` });
  });
  archive.finalize();
});

// ----- xlsx XML builders (one row per non-zero bucket per worker) ----------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function cellRef(c, r) { return colLetter(c) + r; }

function buildContentTypes(sheets) {
  const overrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}
function buildRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}
function buildWorkbook(sheets) {
  const t = sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${t}</sheets>
</workbook>`;
}
function buildWorkbookRels(sheets) {
  const r = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const sId = sheets.length + 1;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${r}
<Relationship Id="rId${sId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}
function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function buildSheetXml(section, run) {
  const cols = ['First & Last Name', 'BSB / Acc', 'Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
    'Total Hours', 'Rate', 'Sub-total', 'Total Wages', 'Travel', 'Meal', 'Other', 'Total Allow.', 'Total'];
  const rows = {};

  // Top corner
  rows[1] = { 1: { v: `Pay run: ${run.label || ''}`, t: 'inlineStr', s: 1 } };
  rows[2] = { 1: { v: `${run.period_start} → ${run.period_end}`, t: 'inlineStr' } };

  // Section heading
  rows[7] = { 1: { v: `${section.name.toUpperCase()} WORKERS`, t: 'inlineStr', s: 1 } };

  // Column headers
  const headerRow = {};
  cols.forEach((c, i) => { if (c) headerRow[i + 1] = { v: c, t: 'inlineStr', s: 3 }; });
  rows[8] = headerRow;

  let r = 9;
  for (const line of section.lines) {
    const buckets = line.buckets || {};
    const activeKeys = section.bucketKeys.filter(k => (buckets[k]?.total_hours || 0) > 0);
    if (activeKeys.length === 0) {
      // Show worker even if no hours, on a single empty row
      activeKeys.push('day_normal');
    }

    activeKeys.forEach((bk, idx) => {
      const b = buckets[bk] || { hours: [0,0,0,0,0,0,0], total_hours: 0, rate: 0, total_wages: 0 };
      const row = {};
      if (idx === 0) {
        row[1] = { v: line.full_name, t: 'inlineStr' };
        row[2] = { v: [line.bsb, line.acc_number].filter(Boolean).join(' / '), t: 'inlineStr' };
      }
      row[3] = { v: BUCKET_LABELS[bk] || bk, t: 'inlineStr' };
      for (let d = 0; d < 7; d++) {
        const h = (b.hours && b.hours[d]) || 0;
        if (h) row[4 + d] = { v: h, t: 'n' };
      }
      row[11] = { v: b.total_hours || 0, t: 'n' };
      row[12] = { v: b.rate || 0, t: 'n', s: 2 };
      row[13] = { v: b.total_wages || 0, t: 'n', s: 2 };
      // Worker totals appear on the LAST row (so it lines up visually)
      if (idx === activeKeys.length - 1) {
        row[14] = { v: line.total_wages || 0, t: 'n', s: 2 };
        row[15] = { v: line.travel_allowance || 0, t: 'n', s: 2 };
        row[16] = { v: line.meal_allowance || 0, t: 'n', s: 2 };
        row[17] = { v: line.other_allowance || 0, t: 'n', s: 2 };
        row[18] = { v: line.total_allowance || 0, t: 'n', s: 2 };
        row[19] = { v: line.grand_total || 0, t: 'n', s: 2 };
      }
      rows[r++] = row;
    });
  }

  // Subtotals
  const totals = section.lines.reduce((acc, l) => {
    acc.total += toNum(l.grand_total); return acc;
  }, { total: 0 });
  r++;
  rows[r++] = { 16: { v: 'Total', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total), t: 'n', s: 2 } };
  if (section.gst) {
    rows[r++] = { 16: { v: 'GST', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total * 0.10), t: 'n', s: 2 } };
    rows[r++] = { 16: { v: 'Total + GST', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total * 1.10), t: 'n', s: 2 } };
  }

  // Render to XML
  let xmlRows = '';
  Object.keys(rows).map(n => parseInt(n, 10)).sort((a, b) => a - b).forEach(rowNum => {
    const row = rows[rowNum];
    const cells = Object.keys(row).map(n => parseInt(n, 10)).sort((a, b) => a - b).map(colNum => {
      const c = row[colNum];
      const ref = cellRef(colNum, rowNum);
      const styleAttr = c.s ? ` s="${c.s}"` : '';
      if (c.t === 'inlineStr') return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${xmlEscape(c.v)}</t></is></c>`;
      return `<c r="${ref}"${styleAttr}><v>${c.v}</v></c>`;
    }).join('');
    xmlRows += `<row r="${rowNum}">${cells}</row>`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${xmlRows}</sheetData>
</worksheet>`;
}

// ============================================================================
// GET /payroll/rates — section-tabbed bulk rate editor.
//
// Schema-aware: builds the SELECT from columns that actually exist so a
// stale deploy missing one (rate_meal, payroll_bsb, award_classification_id, …)
// renders the page anyway with the missing fields treated as 0/null. Top-
// level try/catch turns any other failure into a flash banner — never a
// generic 500. The matching POST below uses the same pattern.
// ============================================================================
router.get('/rates', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
    const WANT = ['id', 'employee_code', 'full_name', 'payment_type',
      'rate_day', 'rate_ot', 'rate_dt',
      'rate_night', 'rate_night_ot', 'rate_night_dt',
      'rate_weekend', 'rate_public_holiday',
      'rate_meal', 'rate_fares_daily',
      'payroll_bsb', 'payroll_account',
      'award_classification_id'];
    const cols = WANT.filter(c => empCols.has(c));
    // id and full_name are required for the page to function. If they're
    // missing the schema is in a state we can't recover from without a
    // proper migration run.
    if (!cols.includes('id') || !cols.includes('full_name')) {
      req.flash('error', 'Employee table is missing core columns — check that migrations have run.');
      return res.redirect('/payroll/runs');
    }
    const activeClause = empCols.has('active') ? 'WHERE active = 1' : '';
    const employees = db.prepare(`SELECT ${cols.join(', ')} FROM employees ${activeClause} ORDER BY LOWER(full_name) ASC`).all();

    let classifications = [];
    try {
      classifications = db.prepare(`
        SELECT id, classification, award_name, effective_from
        FROM award_classifications WHERE active = 1
        ORDER BY classification ASC
      `).all();
    } catch (e) { /* table may not exist on a stale deploy */ }

    res.render('payroll-runs/rates', {
      title: 'Worker Rates',
      currentPage: 'pay-runs',
      employees, classifications,
    });
  } catch (err) {
    console.error('[payroll/rates GET] Unhandled error:', err);
    req.flash('error', 'Could not load Worker Rates: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs');
  }
});

// POST /payroll/rates — bulk update.
//
// Wrapped in a top-level try/catch so any unexpected schema drift on a
// stale deploy (missing column, FK mismatch, anything else) lands as a
// red flash banner instead of an Express 500. Inspect the server log
// for the original error text — it's printed there with a stack trace.
router.post('/rates', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const data = req.body && req.body.rows;
    if (!data || typeof data !== 'object') {
      req.flash('error', 'No rate data submitted.');
      return res.redirect('/payroll/rates');
    }

    // Probe which rate/payroll columns actually exist on this DB. Earlier
    // versions of the schema were missing some of these (rate_meal,
    // rate_fares_daily, rate_public_holiday, payroll_bsb, payroll_account,
    // award_classification_id) and a stale deploy would 500 the whole
    // save the moment we tried to UPDATE a non-existent column. Build the
    // SET clause from the columns that exist so the route works on any
    // deploy generation.
    const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
    const FIELDS = [
      { col: 'payment_type',            kind: 'pt'    },
      { col: 'award_classification_id', kind: 'cid'   },
      { col: 'rate_day',                kind: 'num'   },
      { col: 'rate_ot',                 kind: 'num'   },
      { col: 'rate_dt',                 kind: 'num'   },
      { col: 'rate_night',              kind: 'num'   },
      { col: 'rate_night_ot',           kind: 'num'   },
      { col: 'rate_night_dt',           kind: 'num'   },
      { col: 'rate_weekend',            kind: 'num'   },
      { col: 'rate_public_holiday',     kind: 'num'   },
      { col: 'rate_meal',               kind: 'num'   },
      { col: 'rate_fares_daily',        kind: 'num'   },
      { col: 'payroll_bsb',             kind: 'str'   },
      { col: 'payroll_account',         kind: 'str'   },
    ].filter(f => empCols.has(f.col));
    if (FIELDS.length === 0) {
      req.flash('error', 'Rate columns missing from database — migrations may not have run.');
      return res.redirect('/payroll/rates');
    }

    // Pre-validate award_classification_id values so a stale/missing row
    // in the dropdown doesn't trip the foreign-key constraint.
    const validClassIds = new Set();
    try {
      db.prepare("SELECT id FROM award_classifications").all().forEach(r => validClassIds.add(r.id));
    } catch (e) { /* table missing — treat as no valid ids */ }

    const setClause = FIELDS.map(f => `${f.col} = ?`).join(', ') + ', updated_at = CURRENT_TIMESTAMP';
    const stmt = db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`);

    // Per-row try/catch so one bad employee doesn't take down the whole
    // save. The form posts each row as `rows[emp_<id>][field]`. The
    // `emp_` prefix is critical: without it, qs treats numeric bracket
    // indices as array positions and (for low IDs) compacts the result,
    // throwing away the employee ID entirely.
    let saved = 0;
    const failures = [];
    for (const id of Object.keys(data)) {
      const empId = parseInt(String(id).replace(/^emp_/, ''), 10);
      if (!empId) continue;
      const r = data[id];
      if (!r || typeof r !== 'object') continue;
      try {
        const values = FIELDS.map(f => {
          if (f.kind === 'pt') {
            const pt = String(r.payment_type || '').toLowerCase();
            return ['cash', 'tfn', 'abn'].includes(pt) ? pt : '';
          }
          if (f.kind === 'cid') {
            const cid = parseInt(r.award_classification_id, 10);
            return Number.isFinite(cid) && validClassIds.has(cid) ? cid : null;
          }
          if (f.kind === 'num') return toNum(r[f.col]);
          if (f.kind === 'str') return String(r[f.col] || '').trim();
          return null;
        });
        stmt.run(...values, empId);
        saved++;
      } catch (e) {
        console.error(`[payroll/rates] Failed to save employee ${empId}: ${e.message}`);
        failures.push({ empId, error: e.message });
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityLabel: 'rates', details: `Bulk-updated rates for ${saved} employees${failures.length ? ` (${failures.length} failed)` : ''}`,
        ip: req.ip,
      });
    } catch (e) { /* audit log shouldn't block the save */ }

    if (failures.length === 0) {
      req.flash('success', `Saved rates for ${saved} employees.`);
    } else if (saved > 0) {
      req.flash('error', `Saved ${saved} employees, ${failures.length} failed: ${failures.slice(0, 3).map(f => '#' + f.empId).join(', ')}${failures.length > 3 ? '…' : ''}. Check the server log.`);
    } else {
      req.flash('error', `Save failed for all ${failures.length} employees. ${failures[0] ? 'First error: ' + failures[0].error : ''}`);
    }
    return res.redirect('/payroll/rates');
  } catch (err) {
    // Catch-all — turns any unhandled exception (schema drift, FK trip,
    // anything else) into a flash banner instead of a generic 500 page.
    console.error('[payroll/rates] Unhandled error:', err);
    req.flash('error', 'Save failed: ' + (err && err.message ? err.message : 'unknown error') + '. Check the server log.');
    return res.redirect('/payroll/rates');
  }
});

// ============================================================================
// /payroll/award-rates — Fair Work classification rates
// ============================================================================
router.get('/award-rates', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const classifications = db.prepare(`
    SELECT * FROM award_classifications ORDER BY active DESC, classification ASC
  `).all();
  res.render('payroll-runs/award-rates', {
    title: 'Award Rates',
    currentPage: 'pay-runs',
    classifications,
  });
});

router.post('/award-rates', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const id = parseInt(b.id, 10) || null;
  const fields = {
    award_name: String(b.award_name || '').trim(),
    classification: String(b.classification || '').trim(),
    effective_from: /^\d{4}-\d{2}-\d{2}$/.test(b.effective_from || '') ? b.effective_from : '2024-07-01',
    effective_to: /^\d{4}-\d{2}-\d{2}$/.test(b.effective_to || '') ? b.effective_to : null,
    rate_day: toNum(b.rate_day),
    rate_day_ot: toNum(b.rate_day_ot),
    rate_day_dt: toNum(b.rate_day_dt),
    rate_night: toNum(b.rate_night),
    rate_night_ot: toNum(b.rate_night_ot),
    rate_night_dt: toNum(b.rate_night_dt),
    rate_weekend: toNum(b.rate_weekend),
    rate_public_holiday: toNum(b.rate_public_holiday),
    rate_meal: toNum(b.rate_meal),
    rate_fares_daily: toNum(b.rate_fares_daily),
    notes: String(b.notes || '').trim(),
    active: b.active === '0' ? 0 : 1,
  };
  if (!fields.classification) {
    req.flash('error', 'Classification name is required.');
    return res.redirect('/payroll/award-rates');
  }

  if (id) {
    const cols = Object.keys(fields);
    const setSql = cols.map(c => `${c} = ?`).join(', ');
    const params = cols.map(c => fields[c]);
    params.push(id);
    db.prepare(`UPDATE award_classifications SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
    req.flash('success', `Updated ${fields.classification}.`);
  } else {
    const cols = Object.keys(fields);
    const placeholders = cols.map(() => '?').join(', ');
    const params = cols.map(c => fields[c]);
    db.prepare(`INSERT INTO award_classifications (${cols.join(', ')}) VALUES (${placeholders})`).run(...params);
    req.flash('success', `Added ${fields.classification}.`);
  }
  res.redirect('/payroll/award-rates');
});

router.post('/award-rates/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const cls = db.prepare('SELECT * FROM award_classifications WHERE id = ?').get(req.params.id);
  if (!cls) { req.flash('error', 'Classification not found.'); return res.redirect('/payroll/award-rates'); }
  // Soft-delete: set active = 0 (so historical pay runs aren't broken)
  db.prepare('UPDATE award_classifications SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cls.id);
  req.flash('success', `Deactivated ${cls.classification}.`);
  res.redirect('/payroll/award-rates');
});

// ============================================================================
// /payroll/holidays — public holidays (NSW seeded for 2025–2027)
// ============================================================================
router.get('/holidays', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const holidays = db.prepare('SELECT * FROM public_holidays ORDER BY date ASC').all();
  res.render('payroll-runs/holidays', {
    title: 'Public Holidays',
    currentPage: 'pay-runs',
    holidays,
  });
});

router.post('/holidays', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const date = String(b.date || '').trim();
  const label = String(b.label || '').trim();
  const jurisdiction = String(b.jurisdiction || 'NSW').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !label) {
    req.flash('error', 'Date (YYYY-MM-DD) and label required.');
    return res.redirect('/payroll/holidays');
  }
  try {
    db.prepare('INSERT INTO public_holidays (date, label, jurisdiction) VALUES (?, ?, ?)').run(date, label, jurisdiction);
    req.flash('success', `Added ${label} on ${date}.`);
  } catch (e) {
    req.flash('error', String(e.message).includes('UNIQUE') ? `${date} already exists` : e.message);
  }
  res.redirect('/payroll/holidays');
});

router.post('/holidays/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM public_holidays WHERE id = ?').run(req.params.id);
  req.flash('success', 'Holiday removed.');
  res.redirect('/payroll/holidays');
});

module.exports = router;
