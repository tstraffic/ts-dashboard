// /finance/ute-payments — Ute Payment Sheets
//
// Same shape as the Abergeldie sheet but billed per shift instead of per
// hour. CSV import groups Traffio rows by (plate, driver) into one line per
// combination with shift_count, editable rate_per_shift, and a computed
// total_fee = shifts × rate. Index lists sheets newest-first with
// Ready / Paid checkboxes and bottom-row totals (Total Fee / Total Ready
// to Pay / Total Paid).

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
const { parseCsv, inferPeriod } = require('../lib/payroll');

const DEFAULT_RATE = 0;

// ---------------------------------------------------------------------------
// CSV row → ute shift normaliser
// ---------------------------------------------------------------------------
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Pull plate + driver + date from a Traffio row. Be lenient about column
// names — Traffio's exports vary in casing/spacing across reports.
function normaliseUteRow(row) {
  if (!row) return null;
  const isDeleted = String(row.is_deleted || '').trim() === '1';
  const excluded  = String(row.person_exclude_from_payrun || '').trim() === '1';
  if (isDeleted || excluded) return null;

  const plate = pick(row, [
    'vehicle_registration', 'Vehicle Registration', 'registration', 'Registration',
    'rego', 'Rego', 'plate', 'Plate', 'vehicle_rego', 'Vehicle Rego',
  ]);
  if (!plate) return null; // No plate → not a ute shift

  const driver = pick(row, [
    'full_name', 'Full Name', 'driver_name', 'Driver Name', 'driver', 'Driver',
    'person_full_name', 'Person', 'name', 'Name',
  ]) ||
    ((pick(row, ['first_name', 'First Name']) || '') + ' ' + (pick(row, ['last_name', 'Last Name']) || '')).trim();

  return {
    plate: plate.toUpperCase().replace(/\s+/g, ''),
    driver_name: driver || '(unknown)',
    date: pick(row, ['time_on_date', 'shift_date', 'date', 'Date', 'Shift Date']) || null,
  };
}

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'ute-csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.csv') || '.csv').toLowerCase();
      cb(null, `ute_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
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
function periodLabel(start, end) {
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `WE ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// ===========================================================================
// GET /finance/ute-payments — list (newest period_end first) + totals
// ===========================================================================
router.get('/ute-payments', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const sheets = db.prepare(`
    SELECT s.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM ute_payment_sheet_lines WHERE sheet_id = s.id) AS line_count,
      (SELECT COALESCE(SUM(shift_count), 0) FROM ute_payment_sheet_lines WHERE sheet_id = s.id) AS total_shifts,
      (SELECT COALESCE(SUM(total_fee), 0) FROM ute_payment_sheet_lines WHERE sheet_id = s.id) AS total_fee,
      (SELECT COUNT(DISTINCT plate) FROM ute_payment_sheet_lines WHERE sheet_id = s.id) AS plate_count
    FROM ute_payment_sheets s
    LEFT JOIN users u ON u.id = s.created_by_id
    ORDER BY s.period_end DESC, s.id DESC
    LIMIT 200
  `).all();

  let totalFee = 0, totalReady = 0, totalPaid = 0;
  for (const s of sheets) {
    const fee = parseFloat(s.total_fee) || 0;
    totalFee += fee;
    if (s.paid) totalPaid += fee;
    else if (s.ready_to_pay) totalReady += fee;
  }

  res.render('ute-payments/index', {
    title: 'Ute Payments',
    currentPage: 'ute-payments',
    sheets,
    totals: { fee: round2(totalFee), ready: round2(totalReady), paid: round2(totalPaid) },
    fmtMoney, periodLabel,
  });
});

// ===========================================================================
// GET /finance/ute-payments/new — upload form
// ===========================================================================
router.get('/ute-payments/new', requirePermission('ute_payments'), (req, res) => {
  res.render('ute-payments/new', {
    title: 'New Ute Payment Sheet',
    currentPage: 'ute-payments',
    defaultRate: DEFAULT_RATE,
  });
});

// ===========================================================================
// POST /finance/ute-payments — create from Traffio CSV
// ===========================================================================
router.post('/ute-payments', requirePermission('ute_payments'), (req, res) => {
  upload.single('csv')(req, res, (err) => {
    if (err) { req.flash('error', err.message); return res.redirect('/finance/ute-payments/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/finance/ute-payments/new'); }

    const db = getDb();
    const defaultRate = round2(req.body.default_rate_per_shift);
    const labelInput = String(req.body.label || '').trim();
    const notes = String(req.body.notes || '').trim();

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/finance/ute-payments/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'CSV had no data rows.');
      return res.redirect('/finance/ute-payments/new');
    }

    const uteShifts = rows.map(normaliseUteRow).filter(Boolean);
    if (uteShifts.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', `No ute shifts found in this CSV — looking for a Vehicle Registration / Rego column. Total rows read: ${rows.length}.`);
      return res.redirect('/finance/ute-payments/new');
    }

    // Group by (plate, driver). Tally shift count per group.
    const groups = new Map();
    for (const s of uteShifts) {
      const key = s.plate + '||' + s.driver_name;
      const existing = groups.get(key);
      if (existing) existing.shift_count += 1;
      else groups.set(key, { plate: s.plate, driver_name: s.driver_name, shift_count: 1 });
    }

    const period = inferPeriod(uteShifts);
    const label = labelInput || (`Ute payments — ` + periodLabel(period.period_start, period.period_end));

    let sheetId;
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO ute_payment_sheets
          (period_start, period_end, label, csv_filename, default_rate_per_shift, notes, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        period.period_start, period.period_end, label,
        path.basename(req.file.path), defaultRate, notes,
        req.session.user.id,
      );
      sheetId = r.lastInsertRowid;

      const insertLine = db.prepare(`
        INSERT INTO ute_payment_sheet_lines
          (sheet_id, plate, driver_name, shift_count, rate_per_shift, total_fee, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let order = 0;
      for (const g of Array.from(groups.values()).sort((a, b) => a.plate.localeCompare(b.plate) || a.driver_name.localeCompare(b.driver_name))) {
        const total = round2(g.shift_count * defaultRate);
        insertLine.run(sheetId, g.plate, g.driver_name, g.shift_count, defaultRate, total, order++);
      }
    });
    tx();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'ute_payment_sheet',
      entityId: sheetId, entityLabel: label,
      details: `Imported ${uteShifts.length} ute shifts grouped into ${groups.size} (plate, driver) line(s)`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${uteShifts.length} ute shifts across ${groups.size} (plate, driver) line(s).`);
    res.redirect('/finance/ute-payments/' + sheetId);
  });
});

// ===========================================================================
// GET /finance/ute-payments/:id — show
// ===========================================================================
router.get('/ute-payments/:id', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM ute_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Ute payment sheet not found.'); return res.redirect('/finance/ute-payments'); }

  const lines = db.prepare(`
    SELECT * FROM ute_payment_sheet_lines
    WHERE sheet_id = ?
    ORDER BY plate ASC, LOWER(driver_name) ASC
  `).all(sheet.id);

  let totalShifts = 0, totalFee = 0;
  for (const l of lines) {
    totalShifts += parseInt(l.shift_count, 10) || 0;
    totalFee += parseFloat(l.total_fee) || 0;
  }

  res.render('ute-payments/show', {
    title: sheet.label || 'Ute Payment Sheet',
    currentPage: 'ute-payments',
    sheet, lines,
    grand: {
      shifts: totalShifts,
      fee: round2(totalFee),
      line_count: lines.length,
      plate_count: new Set(lines.map(l => l.plate)).size,
    },
    fmtMoney, periodLabel,
  });
});

// ===========================================================================
// POST /finance/ute-payments/:id — edit sheet metadata
// ===========================================================================
router.post('/ute-payments/:id', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM ute_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Ute payment sheet not found.'); return res.redirect('/finance/ute-payments'); }

  const label = String(req.body.label || '').trim().slice(0, 200);
  const periodStart = String(req.body.period_start || '').trim();
  const periodEnd   = String(req.body.period_end || '').trim();
  const defaultRate = round2(req.body.default_rate_per_shift);
  const notes       = String(req.body.notes || '').trim().slice(0, 1000);
  const applyToAll  = req.body.apply_default_to_all === '1' || req.body.apply_default_to_all === 'on';

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    req.flash('error', 'Period start + end dates are required (YYYY-MM-DD).');
    return res.redirect('/finance/ute-payments/' + sheet.id);
  }
  if (periodEnd < periodStart) {
    req.flash('error', 'Period end must be on or after period start.');
    return res.redirect('/finance/ute-payments/' + sheet.id);
  }
  if (defaultRate < 0) {
    req.flash('error', 'Default rate per shift must be 0 or more.');
    return res.redirect('/finance/ute-payments/' + sheet.id);
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE ute_payment_sheets
      SET label = ?, period_start = ?, period_end = ?, default_rate_per_shift = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(label || sheet.label || '', periodStart, periodEnd, defaultRate, notes, sheet.id);

    if (applyToAll) {
      db.prepare(`
        UPDATE ute_payment_sheet_lines
        SET rate_per_shift = ?,
            total_fee = ROUND(shift_count * ?, 2)
        WHERE sheet_id = ?
      `).run(defaultRate, defaultRate, sheet.id);
    }
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update', entityType: 'ute_payment_sheet',
    entityId: sheet.id, entityLabel: label || sheet.label,
    details: `Updated ute payment sheet (period ${periodStart}→${periodEnd}, default $${defaultRate}/shift, applyToAll=${applyToAll})`,
    ip: req.ip,
  });

  req.flash('success', applyToAll ? 'Sheet updated and rates applied to every line.' : 'Sheet updated.');
  res.redirect('/finance/ute-payments/' + sheet.id);
});

// ===========================================================================
// POST /finance/ute-payments/:id/lines/:lineId — edit a single line
//   Accepts: rate_per_shift, shift_count, plate, driver_name. Recomputes
//   total_fee. Returns JSON for AJAX or redirects.
// ===========================================================================
router.post('/ute-payments/:id/lines/:lineId', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const line = db.prepare('SELECT * FROM ute_payment_sheet_lines WHERE id = ? AND sheet_id = ?').get(req.params.lineId, req.params.id);
  if (!line) {
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Line not found' });
    req.flash('error', 'Line not found.');
    return res.redirect('/finance/ute-payments/' + req.params.id);
  }

  const updates = {};
  if (req.body.rate_per_shift !== undefined) updates.rate_per_shift = Math.max(0, round2(req.body.rate_per_shift));
  if (req.body.shift_count !== undefined)    updates.shift_count    = Math.max(0, parseInt(req.body.shift_count, 10) || 0);
  if (req.body.plate !== undefined)          updates.plate          = String(req.body.plate || '').trim().toUpperCase().slice(0, 20);
  if (req.body.driver_name !== undefined)    updates.driver_name    = String(req.body.driver_name || '').trim().slice(0, 120);
  if (req.body.notes !== undefined)          updates.notes          = String(req.body.notes || '').trim().slice(0, 500);

  // Recompute total_fee from the resulting (rate, count)
  const newRate  = updates.rate_per_shift != null ? updates.rate_per_shift : parseFloat(line.rate_per_shift) || 0;
  const newCount = updates.shift_count    != null ? updates.shift_count    : parseInt(line.shift_count, 10) || 0;
  updates.total_fee = round2(newRate * newCount);

  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]);
  params.push(line.id);
  db.prepare(`UPDATE ute_payment_sheet_lines SET ${setSql} WHERE id = ?`).run(...params);

  if (req.xhr || (req.headers.accept || '').includes('json')) {
    const fresh = db.prepare('SELECT * FROM ute_payment_sheet_lines WHERE id = ?').get(line.id);
    return res.json({ ok: true, line: fresh });
  }
  req.flash('success', 'Line updated.');
  res.redirect('/finance/ute-payments/' + req.params.id);
});

// ===========================================================================
// POST /finance/ute-payments/:id/ready  — toggle ready-to-pay
// POST /finance/ute-payments/:id/paid   — toggle paid
// ===========================================================================
function makeToggle(field) {
  return (req, res) => {
    const db = getDb();
    const sheet = db.prepare('SELECT * FROM ute_payment_sheets WHERE id = ?').get(req.params.id);
    if (!sheet) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Sheet not found.');
      return res.redirect('/finance/ute-payments');
    }
    const checked = req.body.value === '1' || req.body.value === 'on' || req.body.value === 'true' || req.body.value === 1 || req.body.value === true;
    const atCol = field + '_at';
    const byCol = field + '_by_id';
    db.prepare(`
      UPDATE ute_payment_sheets
      SET ${field} = ?, ${atCol} = ?, ${byCol} = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      checked ? 1 : 0,
      checked ? new Date().toISOString() : null,
      checked ? req.session.user.id : null,
      sheet.id,
    );
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      return res.json({ ok: true, [field]: checked ? 1 : 0 });
    }
    return res.redirect('/finance/ute-payments');
  };
}
router.post('/ute-payments/:id/ready', requirePermission('ute_payments'), makeToggle('ready_to_pay'));
router.post('/ute-payments/:id/paid',  requirePermission('ute_payments'), makeToggle('paid'));

// ===========================================================================
// POST /finance/ute-payments/:id/delete
// ===========================================================================
router.post('/ute-payments/:id/delete', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM ute_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Sheet not found.'); return res.redirect('/finance/ute-payments'); }
  db.prepare('DELETE FROM ute_payment_sheets WHERE id = ?').run(sheet.id);
  if (sheet.csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, sheet.csv_filename)); } catch (e) {}
  }
  req.flash('success', `Deleted ${sheet.label}.`);
  res.redirect('/finance/ute-payments');
});

// ===========================================================================
// GET /finance/ute-payments/:id/export.xlsx
// ===========================================================================
router.get('/ute-payments/:id/export.xlsx', requirePermission('ute_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM ute_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).send('Not found');

  const lines = db.prepare(`
    SELECT * FROM ute_payment_sheet_lines
    WHERE sheet_id = ?
    ORDER BY plate ASC, LOWER(driver_name) ASC
  `).all(sheet.id);

  let totalShifts = 0, totalFee = 0;
  for (const l of lines) {
    totalShifts += parseInt(l.shift_count, 10) || 0;
    totalFee += parseFloat(l.total_fee) || 0;
  }

  const sheetXml = buildUteSheetXml({
    sheet, lines,
    totals: { shifts: totalShifts, fee: round2(totalFee) },
  });

  const filename = `Ute_Payments_${(sheet.label || periodLabel(sheet.period_start, sheet.period_end)).replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[ute xlsx]', err); try { res.end(); } catch (e) {} });
  archive.pipe(res);

  archive.append(buildContentTypes(), { name: '[Content_Types].xml' });
  archive.append(buildRels(), { name: '_rels/.rels' });
  archive.append(buildWorkbook(), { name: 'xl/workbook.xml' });
  archive.append(buildWorkbookRels(), { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(buildStyles(), { name: 'xl/styles.xml' });
  archive.append(sheetXml, { name: 'xl/worksheets/sheet1.xml' });
  archive.finalize();
});

// ----- xlsx builders (same shape as the Abergeldie export) -----------------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function cellRef(c, r) { return colLetter(c) + r; }

function buildContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}
function buildRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}
function buildWorkbook() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Ute Payments" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}
function buildWorkbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}
function buildStyles() {
  // 0 = default, 1 = bold, 2 = currency, 3 = bold currency,
  // 4 = bold + grey fill (subtotal label), 5 = bold currency + grey fill,
  // 6 = bold + brand fill (sheet total), 7 = bold currency + brand fill,
  // 8 = integer, 9 = integer bold + grey
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
  <numFmt numFmtId="165" formatCode="0"/>
</numFmts>
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
  <font><b/><sz val="12"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1D6AE5"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellXfs count="10">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`;
}

function buildUteSheetXml({ sheet, lines, totals }) {
  const rows = [];
  let r = 0;
  const rowBuilder = (rowIdx, cells) => {
    const tags = cells.map((cIn, i) => {
      const ref = cellRef(i + 1, rowIdx);
      const c = cIn || {};
      const style = c.s != null ? ` s="${c.s}"` : '';
      if (c.t === 'n') return `<c r="${ref}"${style} t="n"><v>${c.v}</v></c>`;
      if (c.v == null || c.v === '') return `<c r="${ref}"${style}/>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t>${xmlEscape(c.v)}</t></is></c>`;
    });
    return `<row r="${rowIdx}">${tags.join('')}</row>`;
  };

  // Title + period + default rate
  r++;
  rows.push(rowBuilder(r, [{ v: sheet.label || 'Ute Payment Sheet', s: 1 }]));
  r++;
  rows.push(rowBuilder(r, [
    { v: `Period: ${sheet.period_start || ''} → ${sheet.period_end || ''}` },
    null, null,
    { v: `Default rate: $${(parseFloat(sheet.default_rate_per_shift) || 0).toFixed(2)} / shift` },
  ]));
  r++; // blank

  // Column headers
  r++;
  rows.push(rowBuilder(r, [
    { v: 'Plate', s: 1 },
    { v: 'Driver', s: 1 },
    { v: 'Shifts', s: 1 },
    { v: 'Rate / shift', s: 1 },
    { v: 'Total', s: 1 },
  ]));

  // Per-line rows
  lines.forEach(l => {
    r++;
    rows.push(rowBuilder(r, [
      { v: l.plate || '' },
      { v: l.driver_name || '' },
      { t: 'n', v: parseInt(l.shift_count, 10) || 0, s: 8 },
      { t: 'n', v: parseFloat(l.rate_per_shift) || 0, s: 2 },
      { t: 'n', v: parseFloat(l.total_fee) || 0, s: 2 },
    ]));
  });

  // Sheet total
  r++;
  rows.push(rowBuilder(r, [
    { v: 'Sheet total', s: 6 }, { v: '', s: 6 },
    { t: 'n', v: totals.shifts, s: 6 },
    { v: '', s: 6 },
    { t: 'n', v: totals.fee, s: 7 },
  ]));

  const cols = `<cols>
    <col min="1" max="1" width="14" customWidth="1"/>
    <col min="2" max="2" width="28" customWidth="1"/>
    <col min="3" max="3" width="10" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
  </cols>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols}
<sheetData>
${rows.join('\n')}
</sheetData>
</worksheet>`;
}

module.exports = router;
