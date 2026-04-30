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
router.get('/runs', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const runs = db.prepare(`
    SELECT pr.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id) AS line_count,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id) AS grand_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'cash') AS cash_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'tfn') AS tfn_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'abn') AS abn_total,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND COALESCE(payment_type, '') = '') AS unclassified_count,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND paid = 1) AS paid_count
    FROM pay_runs pr
    LEFT JOIN users u ON u.id = pr.created_by_id
    ORDER BY pr.period_end DESC, pr.id DESC
    LIMIT 200
  `).all();

  res.render('payroll-runs/index', {
    title: 'Pay Runs',
    currentPage: 'pay-runs',
    runs, fmtMoney, periodLabel,
  });
});

// ============================================================================
// GET /payroll/runs/new
// ============================================================================
router.get('/runs/new', requirePermission('hr_employees'), (req, res) => {
  res.render('payroll-runs/new', { title: 'Import Pay Run', currentPage: 'pay-runs' });
});

// ============================================================================
// POST /payroll/runs — handle CSV upload
// ============================================================================
router.post('/runs', requirePermission('hr_employees'), (req, res) => {
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
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
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
// GET /payroll/runs/:id — main detail page
// ============================================================================
router.get('/runs/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }

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
router.post('/runs/:id/lines/:lineId', requirePermission('hr_employees'), (req, res) => {
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
router.post('/runs/:id/lines/:lineId/match', requirePermission('hr_employees'), (req, res) => {
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
router.post('/runs/:id/refresh', requirePermission('hr_employees'), (req, res) => {
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
// POST /payroll/runs/:id/delete
// ============================================================================
router.post('/runs/:id/delete', requirePermission('hr_employees'), (req, res) => {
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
router.get('/runs/:id/export.xlsx', requirePermission('hr_employees'), (req, res) => {
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
// GET /payroll/rates — section-tabbed bulk rate editor
// ============================================================================
router.get('/rates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employees = db.prepare(`
    SELECT id, employee_code, full_name, payment_type,
      rate_day, rate_ot, rate_dt,
      rate_night, rate_night_ot, rate_night_dt,
      rate_weekend, rate_public_holiday,
      rate_meal, rate_fares_daily,
      payroll_bsb, payroll_account,
      award_classification_id
    FROM employees
    WHERE active = 1
    ORDER BY LOWER(full_name) ASC
  `).all();
  const classifications = db.prepare(`
    SELECT id, classification, award_name, effective_from
    FROM award_classifications
    WHERE active = 1
    ORDER BY classification ASC
  `).all();
  res.render('payroll-runs/rates', {
    title: 'Worker Rates',
    currentPage: 'pay-runs',
    employees, classifications,
  });
});

// POST /payroll/rates — bulk update
router.post('/rates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const data = req.body && req.body.rows;
  if (!data || typeof data !== 'object') {
    req.flash('error', 'No rate data submitted.');
    return res.redirect('/payroll/rates');
  }

  const stmt = db.prepare(`
    UPDATE employees SET
      payment_type = ?, award_classification_id = ?,
      rate_day = ?, rate_ot = ?, rate_dt = ?,
      rate_night = ?, rate_night_ot = ?, rate_night_dt = ?,
      rate_weekend = ?, rate_public_holiday = ?,
      rate_meal = ?, rate_fares_daily = ?,
      payroll_bsb = ?, payroll_account = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of Object.keys(data)) {
      const empId = parseInt(id, 10);
      if (!empId) continue;
      const r = data[id];
      const pt = String(r.payment_type || '').toLowerCase();
      const cid = parseInt(r.award_classification_id, 10) || null;
      stmt.run(
        ['cash', 'tfn', 'abn'].includes(pt) ? pt : '',
        cid,
        toNum(r.rate_day), toNum(r.rate_ot), toNum(r.rate_dt),
        toNum(r.rate_night), toNum(r.rate_night_ot), toNum(r.rate_night_dt),
        toNum(r.rate_weekend), toNum(r.rate_public_holiday),
        toNum(r.rate_meal), toNum(r.rate_fares_daily),
        String(r.payroll_bsb || '').trim(),
        String(r.payroll_account || '').trim(),
        empId,
      );
      n++;
    }
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update', entityType: 'employee',
    entityLabel: 'rates', details: `Bulk-updated rates for ${n} employees`,
    ip: req.ip,
  });

  req.flash('success', `Saved rates for ${n} employees.`);
  res.redirect('/payroll/rates');
});

// ============================================================================
// /payroll/award-rates — Fair Work classification rates
// ============================================================================
router.get('/award-rates', requirePermission('hr_employees'), (req, res) => {
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

router.post('/award-rates', requirePermission('hr_employees'), (req, res) => {
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

router.post('/award-rates/:id/delete', requirePermission('hr_employees'), (req, res) => {
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
router.get('/holidays', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const holidays = db.prepare('SELECT * FROM public_holidays ORDER BY date ASC').all();
  res.render('payroll-runs/holidays', {
    title: 'Public Holidays',
    currentPage: 'pay-runs',
    holidays,
  });
});

router.post('/holidays', requirePermission('hr_employees'), (req, res) => {
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

router.post('/holidays/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM public_holidays WHERE id = ?').run(req.params.id);
  req.flash('success', 'Holiday removed.');
  res.redirect('/payroll/holidays');
});

module.exports = router;
