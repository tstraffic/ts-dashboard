// /finance/abergeldie — Abergeldie Payment Sheet
//
// Imports a Traffio CSV (Person Dockets OR Person Hours by Client) and keeps
// only the rows where client_name contains "Abergeldie" (case-insensitive,
// substring — "Abergeldie Complex Infrastructure" matches). Each kept row
// becomes a line on the sheet with hours and fee = hours × fee_per_hour.
// The show page groups lines by project_name with per-project subtotals and
// a sheet grand total.
//
// Aim: replace the manual Excel sheet finance currently maintains for billing
// Abergeldie. Same Traffio CSV that drives the pay run can drive this too —
// no double handling.

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { parseCsv, inferPeriod } = require('../lib/payroll');

// Pull a value from a row trying multiple column-name variants. Traffio
// switches casing/spacing between exports (Person Dockets uses
// `time_on_date`, Person Hours by Client uses `Date` etc), so we accept any
// of the common shapes.
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Lenient row → shift normaliser. Unlike lib/payroll's normalizeShift, this
// does NOT require time_on_date — the Abergeldie sheet only needs person +
// project + hours, so an aggregated "Person Hours by Client" export works
// fine even though it has no per-shift date column.
function normaliseAbergeldieRow(row) {
  if (!row) return null;
  const isDeleted = String(row.is_deleted || '').trim() === '1';
  const excluded  = String(row.person_exclude_from_payrun || '').trim() === '1';
  if (isDeleted || excluded) return null;

  const hoursStr = pick(row, ['hours_worked', 'hours', 'total_hours', 'Hours', 'Total Hours']);
  const hours = parseFloat(hoursStr);
  if (!isFinite(hours) || hours <= 0) return null;

  const fullName = pick(row, ['full_name', 'Full Name', 'person_full_name', 'name', 'Name', 'Person']) ||
    ((pick(row, ['first_name', 'First Name']) || '') + ' ' + (pick(row, ['last_name', 'Last Name']) || '')).trim();
  if (!fullName) return null;

  return {
    person_id:        pick(row, ['person_id', 'Person ID', 'employee_reference']),
    full_name:        fullName,
    client_name:      pick(row, ['client_name', 'Client Name', 'client', 'Client']),
    project_name:     pick(row, ['project_name', 'Project Name', 'project', 'Project']),
    job_number:       pick(row, ['job_number', 'Job Number', 'Job #', 'job']),
    booking_id:       pick(row, ['booking_id', 'Booking ID', 'Booking']),
    booking_address:  pick(row, ['booking_address', 'Address', 'address', 'Site Address']),
    date:             pick(row, ['time_on_date', 'shift_date', 'date', 'Date', 'Shift Date']) || null,
    time_on:          pick(row, ['time_on_time', 'time_on', 'start_time', 'Start']),
    time_off:         pick(row, ['time_off_time', 'time_off', 'end_time', 'End']),
    hours,
    notes:            pick(row, ['works_docket_notes', 'notes', 'Notes', 'Comments']),
  };
}

const CLIENT_NAME = 'Abergeldie';
const DEFAULT_FEE_PER_HOUR = 1.50;

// ---------------------------------------------------------------------------
// CSV upload setup — mirrors the pay run import.
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'abergeldie-csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.csv') || '.csv').toLowerCase();
      cb(null, `abergeldie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtHours(n) {
  return (Math.round((parseFloat(n) || 0) * 100) / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function periodLabel(start, end) {
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `WE ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// Filter shifts to those for the target client. Case-insensitive substring so
// "Abergeldie Complex Infrastructure" still matches "Abergeldie".
function shiftIsForClient(shift, clientName) {
  if (!shift) return false;
  const target = String(clientName || '').trim().toLowerCase();
  if (!target) return false;
  const got = String(shift.client_name || '').trim().toLowerCase();
  return got.includes(target);
}

// ===========================================================================
// GET /finance/abergeldie — list of all sheets
// ===========================================================================
router.get('/abergeldie', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheets = db.prepare(`
    SELECT s.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS line_count,
      (SELECT COALESCE(SUM(hours), 0) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS total_hours,
      (SELECT COALESCE(SUM(fee_total), 0) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS total_fee,
      (SELECT COUNT(DISTINCT project_name) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS project_count
    FROM abergeldie_payment_sheets s
    LEFT JOIN users u ON u.id = s.created_by_id
    ORDER BY s.period_end DESC, s.id DESC
    LIMIT 200
  `).all();

  res.render('abergeldie-payments/index', {
    title: 'Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    sheets,
    fmtMoney, fmtHours, periodLabel,
    clientName: CLIENT_NAME,
  });
});

// ===========================================================================
// GET /finance/abergeldie/new — upload form
// ===========================================================================
router.get('/abergeldie/new', requirePermission('abergeldie_payments'), (req, res) => {
  res.render('abergeldie-payments/new', {
    title: 'New Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    clientName: CLIENT_NAME,
    defaultFee: DEFAULT_FEE_PER_HOUR,
  });
});

// ===========================================================================
// POST /finance/abergeldie — create a new sheet from a Traffio CSV
// ===========================================================================
router.post('/abergeldie', requirePermission('abergeldie_payments'), (req, res) => {
  upload.single('csv')(req, res, (err) => {
    if (err) { req.flash('error', err.message); return res.redirect('/finance/abergeldie/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/finance/abergeldie/new'); }

    const db = getDb();
    const feePerHour = round2(req.body.fee_per_hour);
    if (!feePerHour || feePerHour <= 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'Fee per hour must be a positive number.');
      return res.redirect('/finance/abergeldie/new');
    }
    const targetClient = CLIENT_NAME;
    const labelInput = String(req.body.label || '').trim();
    const notes = String(req.body.notes || '').trim();

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/finance/abergeldie/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'CSV had no data rows.');
      return res.redirect('/finance/abergeldie/new');
    }

    const allShifts = rows.map(normaliseAbergeldieRow).filter(Boolean);
    const matchingShifts = allShifts.filter(s => shiftIsForClient(s, targetClient));
    if (matchingShifts.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      const hint = allShifts.length === 0
        ? `Couldn't read any rows from this CSV — check that it's a Traffio export with a Hours column and a Person/Name column.`
        : `No rows mention "${targetClient}". Total rows read: ${allShifts.length}.`;
      req.flash('error', hint);
      return res.redirect('/finance/abergeldie/new');
    }

    const period = inferPeriod(matchingShifts);
    const label = labelInput || (`${targetClient} — ` + periodLabel(period.period_start, period.period_end));

    let sheetId;
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO abergeldie_payment_sheets
          (client_name, period_start, period_end, label, csv_filename, fee_per_hour, notes, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        targetClient, period.period_start, period.period_end, label,
        path.basename(req.file.path), feePerHour, notes,
        req.session.user.id,
      );
      sheetId = r.lastInsertRowid;

      const insertLine = db.prepare(`
        INSERT INTO abergeldie_payment_sheet_lines
          (sheet_id, project_name, job_number, person_id, full_name,
           shift_date, time_on, time_off, hours, fee_per_hour, fee_total,
           booking_address, booking_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of matchingShifts) {
        const hrs = round2(s.hours);
        const fee = round2(hrs * feePerHour);
        insertLine.run(
          sheetId,
          (s.project_name || '').trim() || '(no project name)',
          s.job_number || '',
          s.person_id || '',
          s.full_name || '',
          s.date || null,
          s.time_on || '',
          s.time_off || '',
          hrs,
          feePerHour,
          fee,
          s.booking_address || '',
          s.booking_id || '',
          s.notes || '',
        );
      }
    });
    tx();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'abergeldie_payment_sheet',
      entityId: sheetId, entityLabel: label,
      details: `Imported ${matchingShifts.length} shifts (of ${allShifts.length} total) for client "${targetClient}"`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${matchingShifts.length} shifts for ${targetClient} across ${new Set(matchingShifts.map(s => s.project_name || '(none)')).size} project(s).`);
    res.redirect('/finance/abergeldie/' + sheetId);
  });
});

// ===========================================================================
// GET /finance/abergeldie/:id — sheet detail, grouped by project
// ===========================================================================
router.get('/abergeldie/:id', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }

  const lines = db.prepare(`
    SELECT * FROM abergeldie_payment_sheet_lines
    WHERE sheet_id = ?
    ORDER BY project_name ASC, shift_date ASC, LOWER(full_name) ASC
  `).all(sheet.id);

  // Group by project_name
  const groupsMap = new Map();
  let grandHours = 0, grandFee = 0;
  for (const l of lines) {
    const key = l.project_name || '(no project name)';
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        project_name: key,
        job_number: l.job_number || '',
        booking_address: l.booking_address || '',
        lines: [],
        total_hours: 0,
        total_fee: 0,
      });
    }
    const g = groupsMap.get(key);
    g.lines.push(l);
    g.total_hours += parseFloat(l.hours) || 0;
    g.total_fee += parseFloat(l.fee_total) || 0;
    grandHours += parseFloat(l.hours) || 0;
    grandFee += parseFloat(l.fee_total) || 0;
  }
  const groups = Array.from(groupsMap.values()).sort((a, b) => a.project_name.localeCompare(b.project_name));

  res.render('abergeldie-payments/show', {
    title: sheet.label || 'Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    sheet, groups,
    grand: { hours: round2(grandHours), fee: round2(grandFee), line_count: lines.length, project_count: groups.length },
    fmtMoney, fmtHours, periodLabel,
  });
});

// ===========================================================================
// POST /finance/abergeldie/:id/delete
// ===========================================================================
router.post('/abergeldie/:id/delete', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }
  db.prepare('DELETE FROM abergeldie_payment_sheets WHERE id = ?').run(sheet.id);
  if (sheet.csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, sheet.csv_filename)); } catch (e) { /* ignore */ }
  }
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'abergeldie_payment_sheet',
    entityId: sheet.id, entityLabel: sheet.label,
    details: `Deleted Abergeldie payment sheet ${sheet.label}`, ip: req.ip,
  });
  req.flash('success', `Deleted ${sheet.label}.`);
  res.redirect('/finance/abergeldie');
});

module.exports = router;
