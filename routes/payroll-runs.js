// /payroll/runs — weekly pay runs imported from a Traffio Person Dockets CSV.
// Each pay run breaks workers into Cash / TFN / ABN sections (driven by
// employees.payment_type), aggregates Mon..Sun day/night hours, and snapshots
// rates at import time so historical runs are immutable.
//
// Mounted at /payroll alongside the older payslips-admin router; the two
// don't overlap (this owns /runs/* and /rates*).

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
  matchEmployee, buildLine, recomputeLine, formatLocalDate,
  round2, toNum,
} = require('../lib/payroll');

// ----------------------------------------------------------------------------
// Upload setup — keep the original Traffio CSV alongside the run for audit.
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const okExt = /\.csv$/i.test(file.originalname || '');
    const okMime = /text|csv|excel|octet-stream/i.test(file.mimetype || '');
    if (!okExt && !okMime) return cb(new Error('CSV files only'));
    cb(null, true);
  },
});

// ----------------------------------------------------------------------------
// Section labels + ordering
// ----------------------------------------------------------------------------
const SECTIONS = [
  { key: 'cash', label: 'Cash', accent: 'amber' },
  { key: 'tfn',  label: 'TFN',  accent: 'emerald' },
  { key: 'abn',  label: 'ABN',  accent: 'sky' },
];
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; }
}

function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function periodLabel(start, end) {
  // "WE 26.04.26"  (Week ending Sunday)
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(2);
  return `WE ${dd}.${mm}.${yy}`;
}

// ============================================================================
// GET /payroll/runs — list all pay runs, newest first
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
    runs,
    fmtMoney,
    periodLabel,
  });
});

// ============================================================================
// GET /payroll/runs/new — upload form
// ============================================================================
router.get('/runs/new', requirePermission('hr_employees'), (req, res) => {
  res.render('payroll-runs/new', {
    title: 'Import Pay Run',
    currentPage: 'pay-runs',
  });
});

// ============================================================================
// POST /payroll/runs — handle CSV upload, parse, create pay_run + lines
// ============================================================================
router.post('/runs', requirePermission('hr_employees'), (req, res) => {
  upload.single('csv')(req, res, function (err) {
    if (err) { req.flash('error', err.message); return res.redirect('/payroll/runs/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/payroll/runs/new'); }

    let raw;
    try {
      raw = fs.readFileSync(req.file.path, 'utf8');
    } catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/payroll/runs/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      req.flash('error', 'CSV had no data rows. Please check the file is a valid Traffio Person Dockets export.');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    const shifts = rows.map(normalizeShift).filter(Boolean);
    if (shifts.length === 0) {
      req.flash('error', 'CSV had no usable shifts (all rows excluded, deleted, or zero hours).');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    // Allow user to override the inferred period via form fields
    const inferred = inferPeriod(shifts);
    const period_start = (req.body.period_start && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_start))
      ? req.body.period_start : inferred.period_start;
    const period_end = (req.body.period_end && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_end))
      ? req.body.period_end : inferred.period_end;
    const label = (req.body.label || '').trim() || periodLabel(period_start, period_end);
    const notes = (req.body.notes || '').trim();

    const workers = aggregateByWorker(shifts);
    const db = getDb();

    let runId;
    try {
      const insertRun = db.prepare(`
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `);
      const insertLine = db.prepare(`
        INSERT INTO pay_run_lines (
          pay_run_id, employee_id, person_id, full_name, payment_type, bsb, acc_number,
          day_hours_json, night_hours_json,
          total_day_hours, total_night_hours, total_hours,
          rate_day, rate_night,
          total_day_wages, total_night_wages, total_wages,
          travel_allowance, meal_allowance, other_allowance, total_allowance,
          grand_total, paid, paid_ref, paid_at, notes, shifts_json, sort_order
        ) VALUES (
          @pay_run_id, @employee_id, @person_id, @full_name, @payment_type, @bsb, @acc_number,
          @day_hours_json, @night_hours_json,
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
          const line = buildLine({ pay_run_id: runId, agg, employee });
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
// GET /payroll/runs/:id — main pay run detail page
//   Renders Cash / TFN / ABN sections plus an Unclassified bucket.
// ============================================================================
router.get('/runs/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }

  const lines = db.prepare(`
    SELECT prl.*, e.employee_code, e.full_name AS emp_full_name,
      e.payment_type AS emp_payment_type, e.rate_day AS emp_rate_day, e.rate_night AS emp_rate_night
    FROM pay_run_lines prl
    LEFT JOIN employees e ON e.id = prl.employee_id
    WHERE prl.pay_run_id = ?
    ORDER BY prl.payment_type ASC, LOWER(prl.full_name) ASC
  `).all(run.id);

  // Hydrate JSON arrays + bucket by payment_type
  const buckets = { cash: [], tfn: [], abn: [], unclassified: [] };
  for (const l of lines) {
    l.day_hours = safeJson(l.day_hours_json, [0, 0, 0, 0, 0, 0, 0]);
    l.night_hours = safeJson(l.night_hours_json, [0, 0, 0, 0, 0, 0, 0]);
    l.shifts = safeJson(l.shifts_json, []);
    const t = (l.payment_type || '').toLowerCase();
    if (t === 'cash') buckets.cash.push(l);
    else if (t === 'tfn') buckets.tfn.push(l);
    else if (t === 'abn') buckets.abn.push(l);
    else buckets.unclassified.push(l);
  }

  // Section totals + GST (Cash only)
  function sectionTotal(arr) {
    let hours = 0, wages = 0, allow = 0, total = 0;
    for (const l of arr) { hours += toNum(l.total_hours); wages += toNum(l.total_wages); allow += toNum(l.total_allowance); total += toNum(l.grand_total); }
    return { hours: round2(hours), wages: round2(wages), allow: round2(allow), total: round2(total), gst: round2(total * 0.10), with_gst: round2(total * 1.10) };
  }
  const totals = {
    cash: sectionTotal(buckets.cash),
    tfn:  sectionTotal(buckets.tfn),
    abn:  sectionTotal(buckets.abn),
    unclassified: sectionTotal(buckets.unclassified),
  };
  const grand = {
    total: round2(totals.cash.total + totals.tfn.total + totals.abn.total + totals.unclassified.total),
    paid: round2(lines.filter(l => l.paid).reduce((s, l) => s + toNum(l.grand_total), 0)),
    paid_count: lines.filter(l => l.paid).length,
    line_count: lines.length,
  };

  // Pull active employees for the "Match to employee" dropdown on Unclassified rows
  const employees = db.prepare(`
    SELECT id, employee_code, full_name, payment_type, rate_day, rate_night
    FROM employees WHERE active = 1 ORDER BY LOWER(full_name) ASC
  `).all();

  res.render('payroll-runs/show', {
    title: run.label || periodLabel(run.period_start, run.period_end),
    currentPage: 'pay-runs',
    run,
    sections: SECTIONS,
    dowLabels: DOW_LABELS,
    buckets,
    totals,
    grand,
    employees,
    fmtMoney,
    periodLabel,
  });
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId — update a line
//   Accepts JSON or form body. Recomputes totals after every update.
// ============================================================================
router.post('/runs/:id/lines/:lineId', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Pay run not found' });
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, run.id);
  if (!line) return res.status(404).json({ error: 'Line not found' });

  const b = req.body || {};
  const updates = {};

  // Hours editing — accept day_hours / night_hours arrays of 7 numbers
  if (Array.isArray(b.day_hours) && b.day_hours.length === 7) {
    updates.day_hours_json = JSON.stringify(b.day_hours.map(toNum));
  }
  if (Array.isArray(b.night_hours) && b.night_hours.length === 7) {
    updates.night_hours_json = JSON.stringify(b.night_hours.map(toNum));
  }

  // Rate editing — also write back to employees if requested
  if (b.rate_day !== undefined) updates.rate_day = toNum(b.rate_day);
  if (b.rate_night !== undefined) updates.rate_night = toNum(b.rate_night);

  // Allowances
  if (b.travel_allowance !== undefined) updates.travel_allowance = toNum(b.travel_allowance);
  if (b.meal_allowance !== undefined) updates.meal_allowance = toNum(b.meal_allowance);
  if (b.other_allowance !== undefined) updates.other_allowance = toNum(b.other_allowance);

  // BSB / account
  if (b.bsb !== undefined) updates.bsb = String(b.bsb || '').trim();
  if (b.acc_number !== undefined) updates.acc_number = String(b.acc_number || '').trim();

  // Payment type
  if (b.payment_type !== undefined) {
    const pt = String(b.payment_type || '').toLowerCase();
    updates.payment_type = ['cash', 'tfn', 'abn'].includes(pt) ? pt : '';
  }

  // Paid toggle / ref
  if (b.paid !== undefined) {
    const paidNow = (b.paid === true || b.paid === '1' || b.paid === 1 || b.paid === 'true' || b.paid === 'on') ? 1 : 0;
    updates.paid = paidNow;
    if (paidNow && !line.paid_at) updates.paid_at = new Date().toISOString();
    if (!paidNow) updates.paid_at = null;
  }
  if (b.paid_ref !== undefined) updates.paid_ref = String(b.paid_ref || '').trim();

  // Notes
  if (b.notes !== undefined) updates.notes = String(b.notes || '').trim();

  // Apply core edits, then recompute totals from the merged state
  const merged = Object.assign({}, line, updates);
  const recomputed = recomputeLine(merged);
  Object.assign(updates, recomputed);
  updates.updated_at = new Date().toISOString();

  // Build the UPDATE
  const cols = Object.keys(updates);
  if (cols.length === 0) return res.json({ ok: true, line });
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]);
  params.push(req.params.lineId);
  db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);

  // Optionally persist BSB / account / rates back to the employee record
  if (line.employee_id) {
    const empUpdates = [];
    const empParams = [];
    if (b.save_bsb_to_employee && (b.bsb !== undefined || b.acc_number !== undefined)) {
      if (b.bsb !== undefined)        { empUpdates.push('payroll_bsb = ?');     empParams.push(updates.bsb); }
      if (b.acc_number !== undefined) { empUpdates.push('payroll_account = ?'); empParams.push(updates.acc_number); }
    }
    if (b.save_rates_to_employee && (b.rate_day !== undefined || b.rate_night !== undefined)) {
      if (b.rate_day !== undefined)   { empUpdates.push('rate_day = ?');   empParams.push(updates.rate_day); }
      if (b.rate_night !== undefined) { empUpdates.push('rate_night = ?'); empParams.push(updates.rate_night); }
    }
    if (b.save_payment_type_to_employee && b.payment_type !== undefined) {
      empUpdates.push('payment_type = ?'); empParams.push(updates.payment_type);
    }
    if (empUpdates.length > 0) {
      empParams.push(line.employee_id);
      db.prepare(`UPDATE employees SET ${empUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...empParams);
    }
  }

  // Re-fetch the line for the response
  const fresh = db.prepare('SELECT * FROM pay_run_lines WHERE id = ?').get(req.params.lineId);
  fresh.day_hours = safeJson(fresh.day_hours_json, [0, 0, 0, 0, 0, 0, 0]);
  fresh.night_hours = safeJson(fresh.night_hours_json, [0, 0, 0, 0, 0, 0, 0]);

  // AJAX → JSON; form submit → redirect back to the run
  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.json({ ok: true, line: fresh });
  return res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId/match — match an unmatched line to an
// existing employee. Pulls rate + payment_type + BSB from employee if requested.
// ============================================================================
router.post('/runs/:id/lines/:lineId/match', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
  if (!line) { req.flash('error', 'Line not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const empId = parseInt(req.body.employee_id, 10);
  if (!empId) { req.flash('error', 'Pick an employee'); return res.redirect('/payroll/runs/' + req.params.id); }
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (!emp) { req.flash('error', 'Employee not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const updates = {
    employee_id: emp.id,
    payment_type: (emp.payment_type && ['cash', 'tfn', 'abn'].includes(String(emp.payment_type).toLowerCase()))
      ? String(emp.payment_type).toLowerCase() : line.payment_type || '',
    bsb: line.bsb || (emp.payroll_bsb || ''),
    acc_number: line.acc_number || (emp.payroll_account || ''),
    rate_day: toNum(emp.rate_day) || line.rate_day,
    rate_night: toNum(emp.rate_night) || line.rate_night,
    updated_at: new Date().toISOString(),
  };
  const recomputed = recomputeLine(Object.assign({}, line, updates));
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
// POST /payroll/runs/:id/delete — delete a pay run (cascades to lines)
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
// GET /payroll/runs/:id/export.xlsx — download the run as an xlsx mirroring
// the existing T&S template (Cash + Management / TFN / ABN sheets).
// ============================================================================
router.get('/runs/:id/export.xlsx', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).send('Pay run not found');

  const lines = db.prepare(`
    SELECT * FROM pay_run_lines WHERE pay_run_id = ?
    ORDER BY payment_type ASC, LOWER(full_name) ASC
  `).all(run.id);
  for (const l of lines) {
    l.day_hours = safeJson(l.day_hours_json, [0, 0, 0, 0, 0, 0, 0]);
    l.night_hours = safeJson(l.night_hours_json, [0, 0, 0, 0, 0, 0, 0]);
  }

  const cash = lines.filter(l => l.payment_type === 'cash');
  const tfn  = lines.filter(l => l.payment_type === 'tfn');
  const abn  = lines.filter(l => l.payment_type === 'abn');

  const filename = `PayRun_${(run.label || periodLabel(run.period_start, run.period_end)).replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('xlsx archive error:', err); try { res.end(); } catch (e) {} });
  archive.pipe(res);

  // [Content_Types].xml + workbook + sheets
  const sheets = [
    { name: 'Cash', heading: 'CASH WORKERS', lines: cash, gst: true },
    { name: 'TFN',  heading: 'TFN WORKERS',  lines: tfn,  gst: false },
    { name: 'ABN',  heading: 'ABN WORKERS',  lines: abn,  gst: false },
  ];

  archive.append(buildContentTypes(sheets), { name: '[Content_Types].xml' });
  archive.append(buildRels(), { name: '_rels/.rels' });
  archive.append(buildWorkbook(sheets), { name: 'xl/workbook.xml' });
  archive.append(buildWorkbookRels(sheets), { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(buildStyles(), { name: 'xl/styles.xml' });
  sheets.forEach((s, idx) => {
    archive.append(buildSheetXml(s, run), { name: `xl/worksheets/sheet${idx + 1}.xml` });
  });
  archive.finalize();
});

// ----- xlsx XML builders ---------------------------------------------------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { // 1 → A, 27 → AA
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function cellRef(col, row) { return colLetter(col) + row; }

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
  const sheetTags = sheets.map((s, i) =>
    `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetTags}</sheets>
</workbook>`;
}
function buildWorkbookRels(sheets) {
  const rels = sheets.map((s, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  const stylesId = sheets.length + 1;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
<Relationship Id="rId${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}
function buildStyles() {
  // 0 = default, 1 = bold header, 2 = currency, 3 = bold + grey fill
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

// Build a single worksheet matching the T&S template:
//  Row 1-6: padding (top totals area)
//  Row 7: section heading (e.g. "CASH WORKERS")
//  Row 8: column headers
//  Rows 9+: per-worker pairs (Day row, Night row)
//  Last rows: subtotals (+ GST for Cash)
function buildSheetXml(section, run) {
  const cols = ['First & Last Name', '', 'BSB / Acc', 'Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
    'Total Hours', 'Rate', 'Total', 'Total Wages', 'Travel', 'Meal', 'Other Allow.', 'Total Allow.', 'Total'];
  const rows = [];

  // Row 7: section heading
  const headingRow = [];
  headingRow[1] = { v: section.heading, t: 'inlineStr', s: 1 };
  rows[7] = headingRow;

  // Row 8: column headers
  const headerRow = {};
  cols.forEach((c, i) => { if (c) headerRow[i + 1] = { v: c, t: 'inlineStr', s: 3 }; });
  rows[8] = headerRow;

  let r = 9;
  for (const line of section.lines) {
    // Day row
    const dayR = {};
    dayR[1] = { v: line.full_name, t: 'inlineStr' };
    dayR[3] = { v: [line.bsb, line.acc_number].filter(Boolean).join(' / '), t: 'inlineStr' };
    dayR[4] = { v: 'Day', t: 'inlineStr' };
    for (let d = 0; d < 7; d++) {
      const h = (line.day_hours[d] || 0);
      if (h) dayR[5 + d] = { v: h, t: 'n' };
    }
    dayR[12] = { v: line.total_day_hours || 0, t: 'n' };
    dayR[13] = { v: line.rate_day || 0, t: 'n', s: 2 };
    dayR[14] = { v: line.total_day_wages || 0, t: 'n', s: 2 };
    dayR[15] = { v: line.total_wages || 0, t: 'n', s: 2 };
    dayR[16] = { v: line.travel_allowance || 0, t: 'n', s: 2 };
    dayR[17] = { v: line.meal_allowance || 0, t: 'n', s: 2 };
    dayR[18] = { v: line.other_allowance || 0, t: 'n', s: 2 };
    dayR[19] = { v: line.total_allowance || 0, t: 'n', s: 2 };
    dayR[20] = { v: line.grand_total || 0, t: 'n', s: 2 };
    rows[r++] = dayR;

    // Night row
    const nightR = {};
    nightR[4] = { v: 'Night', t: 'inlineStr' };
    for (let d = 0; d < 7; d++) {
      const h = (line.night_hours[d] || 0);
      if (h) nightR[5 + d] = { v: h, t: 'n' };
    }
    nightR[12] = { v: line.total_night_hours || 0, t: 'n' };
    nightR[13] = { v: line.rate_night || 0, t: 'n', s: 2 };
    nightR[14] = { v: line.total_night_wages || 0, t: 'n', s: 2 };
    rows[r++] = nightR;
  }

  // Subtotals
  const totals = section.lines.reduce((acc, l) => {
    acc.total += toNum(l.grand_total); acc.wages += toNum(l.total_wages); acc.allow += toNum(l.total_allowance); return acc;
  }, { total: 0, wages: 0, allow: 0 });
  r++; // gap
  const totalRow = {};
  totalRow[17] = { v: 'Total', t: 'inlineStr', s: 1 };
  totalRow[20] = { v: round2(totals.total), t: 'n', s: 2 };
  rows[r++] = totalRow;
  if (section.gst) {
    const gstRow = {};
    gstRow[17] = { v: 'GST', t: 'inlineStr', s: 1 };
    gstRow[20] = { v: round2(totals.total * 0.10), t: 'n', s: 2 };
    rows[r++] = gstRow;
    const withGst = {};
    withGst[17] = { v: 'Total + GST', t: 'inlineStr', s: 1 };
    withGst[20] = { v: round2(totals.total * 1.10), t: 'n', s: 2 };
    rows[r++] = withGst;
  }

  // Top corner: pay run label + period
  rows[1] = { 1: { v: `Pay run: ${run.label || ''}`, t: 'inlineStr', s: 1 } };
  rows[2] = { 1: { v: `${run.period_start} → ${run.period_end}`, t: 'inlineStr' } };

  // Render rows → XML
  let xmlRows = '';
  Object.keys(rows).map(n => parseInt(n, 10)).sort((a, b) => a - b).forEach(rowNum => {
    const row = rows[rowNum];
    const cells = Object.keys(row).map(n => parseInt(n, 10)).sort((a, b) => a - b).map(colNum => {
      const c = row[colNum];
      const ref = cellRef(colNum, rowNum);
      const styleAttr = c.s ? ` s="${c.s}"` : '';
      if (c.t === 'inlineStr') {
        return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${xmlEscape(c.v)}</t></is></c>`;
      }
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
// GET /payroll/rates — set rate_day / rate_night for all employees in one screen
// ============================================================================
router.get('/rates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employees = db.prepare(`
    SELECT id, employee_code, full_name, payment_type, rate_day, rate_night,
      payroll_bsb, payroll_account
    FROM employees
    WHERE active = 1
    ORDER BY payment_type DESC, LOWER(full_name) ASC
  `).all();
  res.render('payroll-runs/rates', {
    title: 'Worker Rates',
    currentPage: 'pay-runs',
    employees,
  });
});

// POST /payroll/rates — bulk update rates + payment_type + BSB
router.post('/rates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const data = req.body && req.body.rows;
  if (!data || typeof data !== 'object') {
    req.flash('error', 'No rate data submitted.');
    return res.redirect('/payroll/rates');
  }

  const stmt = db.prepare(`
    UPDATE employees SET
      rate_day = ?, rate_night = ?,
      payment_type = ?,
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
      stmt.run(
        toNum(r.rate_day), toNum(r.rate_night),
        ['cash', 'tfn', 'abn'].includes(pt) ? pt : '',
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

module.exports = router;
