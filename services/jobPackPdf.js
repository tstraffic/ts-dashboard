// Branded PDF renderer for submitted Job-Pack checklists.
// Output mirrors the Traffio original: T&S header, submitter / date /
// booking / vehicle band, then the form's answers in a clean two-column
// label/value layout, photos grouped by tag, signature at the bottom.
//
// Usage:
//   const buf = await renderSubmissionPdf(db, submissionId);
//   res.type('application/pdf').send(buf);

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const BRAND = '#1D6AE5';
const GRAY_DARK = '#1F2937';
const GRAY_MED = '#4B5563';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG = '#F9FAFB';
const GREEN = '#059669';
const RED = '#DC2626';
const AMBER = '#D97706';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 40, MR = 40, MT = 40, MB = 40;

const FORM_HEADING = {
  vehicle_prestart:   '1. T&S Vehicle Pre-Start',
  risk_toolbox:       '2. Risk Assessment and Toolbox',
  tc_prestart:        '3. Traffic Controller Prestart Declaration',
  team_leader:        '4. Team Leader Checklist',
  post_shift_vehicle: '5. Post Shift Vehicle Checklist',
  prestart:           'Pre-Start Checklist',
  take5:              'Take 5 Safety Check',
  hazard:             'Hazard Report',
  incident:           'Incident Report',
  equipment:          'Equipment Check',
};

// Keys we recognise as item-checklists (Vehicle Pre-Start has data.items as
// { key: 'ok' | 'not_ok' | 'na' }; Team Leader has data.ppe as { key: bool }).
// Each answer renderer knows how to format these into the right widget.
const TAG_LABEL = {
  arrow_board: 'Arrow board',
  setup: 'Site setup',
  team: 'Team / PPE',
  interior: 'Vehicle interior',
  equipment_cage: 'Equipment cage',
  fuel_gauge: 'Fuel gauge',
  other: 'Other',
};

function prettify(s) {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return String(s); }
}

// Decode a "data:image/png;base64,…" signature data URL into a Buffer for
// pdfkit's image() call. Returns null when the value isn't actually a data URL.
function dataUrlToBuffer(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

function drawHeader(doc, sub) {
  const formTitle = FORM_HEADING[sub.form_type] || prettify(sub.form_type || 'Submission');
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { width: 70 }); } catch (_) {}
  }
  doc.fillColor(GRAY_DARK).font('Helvetica-Bold').fontSize(20)
    .text(formTitle, ML + 90, MT + 4, { width: doc.page.width - ML - MR - 90, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY_MED)
    .text('T&S Traffic Control PTY LTD.', ML + 90, MT + 30, { align: 'right' })
    .text('9 Epic Pl, Villawood, NSW 2163', { align: 'right' })
    .text('ABN 58 655 958 320  ·  E admin@tstc.com.au  ·  P 1300 00 8782', { align: 'right' });
  // Divider line
  doc.moveTo(ML, MT + 78).lineTo(doc.page.width - MR, MT + 78).strokeColor(BRAND).lineWidth(1.5).stroke();
  doc.y = MT + 90;
}

function drawHeaderBand(doc, sub) {
  // 4-column band: Submitted by / Date / Booking / Vehicle (or 3 cols if no
  // vehicle on this form_type).
  const includeVehicle = ['vehicle_prestart','post_shift_vehicle'].includes(sub.form_type);
  const cols = includeVehicle ? 4 : 3;
  const innerW = doc.page.width - ML - MR;
  const colW = innerW / cols;
  const startY = doc.y;
  const headers = ['Submitted by', 'Date', 'Booking'];
  if (includeVehicle) headers.push('Vehicle');

  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_DARK);
  headers.forEach((h, i) => doc.text(h, ML + colW * i + 6, startY + 4, { width: colW - 12 }));
  doc.font('Helvetica').fontSize(9).fillColor(GRAY_DARK);

  const submittedBy = sub.signed_name || sub.crew_name || '—';
  const dateStr = fmtDate(sub.submitted_at);
  const bookingLines = [];
  if (sub.job_client) bookingLines.push(sub.job_client);
  if (sub.job_number) bookingLines.push(sub.job_number);
  if (sub.job_name && sub.job_name !== sub.job_client) bookingLines.push(sub.job_name);
  // Pull data.vehicle from the answers JSON for vehicle forms
  let vehicleStr = '—';
  try {
    const parsed = sub.data ? JSON.parse(sub.data) : {};
    if (includeVehicle && parsed.vehicle) vehicleStr = String(parsed.vehicle);
  } catch (_) {}

  const valY = startY + 18;
  doc.text(submittedBy, ML + 6, valY, { width: colW - 12 });
  doc.text(dateStr, ML + colW + 6, valY, { width: colW - 12 });
  doc.text(bookingLines.join('\n') || '—', ML + colW * 2 + 6, valY, { width: colW - 12 });
  if (includeVehicle) doc.text(vehicleStr, ML + colW * 3 + 6, valY, { width: colW - 12 });

  // Box around the band (height = max text + padding)
  const bandH = Math.max(60, doc.y - startY + 8);
  doc.rect(ML, startY - 2, innerW, bandH).strokeColor(GRAY_LINE).lineWidth(0.6).stroke();
  doc.y = startY + bandH + 8;
}

function ensureSpace(doc, h) {
  if (doc.y + h > doc.page.height - MB) {
    doc.addPage();
    doc.y = MT;
  }
}

function drawSection(doc, title) {
  ensureSpace(doc, 28);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND).text(title, ML, doc.y);
  doc.moveDown(0.4);
  doc.strokeColor(GRAY_LINE).lineWidth(0.5).moveTo(ML, doc.y).lineTo(doc.page.width - MR, doc.y).stroke();
  doc.moveDown(0.4);
}

// One row in the answers list: label on the left (35% of width), value on
// the right. Handles strings, booleans, arrays (rendered as " · "-joined
// chips), nested objects (each key → indented sub-row).
function drawAnswerRow(doc, label, value, depth = 0) {
  const innerW = doc.page.width - ML - MR;
  const labelW = 0.35 * innerW;
  const valueW = innerW - labelW - 8;
  const x = ML + depth * 12;
  const ax = x + labelW + 8;

  const renderVal = (v) => {
    if (v == null || v === '') return { text: '—', color: GRAY_MED };
    if (Array.isArray(v)) return { text: v.length ? v.join('  ·  ') : '— (none selected)', color: GRAY_DARK };
    if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No', color: v ? GREEN : GRAY_MED, bold: true };
    if (typeof v === 'object') return null; // walked separately
    const s = String(v).toLowerCase();
    if (s === 'ok')     return { text: 'OK', color: GREEN, bold: true };
    if (s === 'not_ok') return { text: 'NOT OK', color: RED, bold: true };
    if (s === 'na')     return { text: 'N/A', color: GRAY_MED };
    return { text: String(v), color: GRAY_DARK };
  };

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Heading row, then walk children indented.
    ensureSpace(doc, 16);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_DARK)
      .text(prettify(label), x, doc.y, { width: innerW - depth * 12 });
    doc.moveDown(0.2);
    Object.keys(value).forEach(k => drawAnswerRow(doc, k, value[k], depth + 1));
    return;
  }

  const v = renderVal(value);
  if (!v) return;

  // Text-height pre-calculation for the value cell so we can grow the row.
  doc.font('Helvetica').fontSize(9);
  const valStr = v.text;
  const valH = doc.heightOfString(valStr, { width: valueW });
  doc.font('Helvetica').fontSize(9);
  const lblH = doc.heightOfString(prettify(label), { width: labelW });
  const rowH = Math.max(valH, lblH) + 6;
  ensureSpace(doc, rowH);

  const y0 = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED).text(prettify(label), x, y0, { width: labelW });
  doc.font(v.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(v.color)
    .text(valStr, ax, y0, { width: valueW });
  doc.y = y0 + rowH;
}

// Render every key/value pair in the answers payload.
function drawAnswers(doc, parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  // Most forms keep their answers at the top level (Vehicle Pre-Start,
  // Team Leader, etc). Risk Assessment nests them under data.answers — fall
  // back to the top-level keys for everything else.
  let entries = [];
  if (parsed.answers && typeof parsed.answers === 'object') {
    entries = Object.entries(parsed.answers);
    Object.entries(parsed).forEach(([k, v]) => { if (k !== 'answers') entries.push([k, v]); });
  } else {
    entries = Object.entries(parsed);
  }
  drawSection(doc, 'Answers');
  for (const [k, v] of entries) drawAnswerRow(doc, k, v);
}

function drawPhotos(doc, photos) {
  if (!photos || !photos.length) return;
  drawSection(doc, 'Photos');

  // Group by tag
  const byTag = {};
  for (const p of photos) {
    (byTag[p.tag || 'other'] = byTag[p.tag || 'other'] || []).push(p);
  }

  for (const tag of Object.keys(byTag)) {
    ensureSpace(doc, 24);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_DARK).text(TAG_LABEL[tag] || prettify(tag), ML, doc.y);
    doc.moveDown(0.3);

    const innerW = doc.page.width - ML - MR;
    const cols = 3;
    const gap = 8;
    const cellW = (innerW - gap * (cols - 1)) / cols;
    const cellH = cellW * 0.75;

    let i = 0;
    for (const p of byTag[tag]) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (col === 0) {
        ensureSpace(doc, cellH + gap);
      }
      const x = ML + col * (cellW + gap);
      const y = doc.y + row * (cellH + gap);
      try {
        const abs = path.isAbsolute(p.file_path) ? p.file_path : path.join(__dirname, '..', p.file_path);
        if (fs.existsSync(abs)) {
          doc.image(abs, x, y, { fit: [cellW, cellH], align: 'center', valign: 'center' });
          doc.rect(x, y, cellW, cellH).strokeColor(GRAY_LINE).lineWidth(0.4).stroke();
        }
      } catch (e) {
        // Skip unrenderable image, draw placeholder
        doc.rect(x, y, cellW, cellH).strokeColor(GRAY_LINE).lineWidth(0.4).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(GRAY_MED).text('Image unavailable', x, y + cellH/2 - 4, { width: cellW, align: 'center' });
      }
      i++;
    }
    const rowsUsed = Math.ceil(byTag[tag].length / cols);
    doc.y = doc.y + rowsUsed * (cellH + gap);
  }
}

function drawSignature(doc, sub) {
  if (!sub.signature_data) return;
  ensureSpace(doc, 110);
  drawSection(doc, 'Signature');
  const buf = dataUrlToBuffer(sub.signature_data);
  if (buf) {
    try {
      doc.image(buf, ML, doc.y, { fit: [220, 80] });
      doc.moveDown(5);
    } catch (e) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED).text('(signature image could not be rendered)', ML, doc.y);
      doc.moveDown();
    }
  }
  if (sub.signed_name) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_DARK).text('Name: ' + sub.signed_name, ML, doc.y);
  }
}

function renderSubmissionPdf(db, submissionId) {
  return new Promise((resolve, reject) => {
    const sub = db.prepare(`
      SELECT sf.*, cm.full_name AS crew_name, cm.employee_id AS employee_code,
        j.job_number, j.client AS job_client, j.job_name
      FROM safety_forms sf
      LEFT JOIN crew_members cm ON sf.crew_member_id = cm.id
      LEFT JOIN jobs j ON sf.job_id = j.id
      WHERE sf.id = ?
    `).get(submissionId);
    if (!sub) return reject(new Error('Submission not found: ' + submissionId));

    const photos = db.prepare(`
      SELECT * FROM safety_form_photos WHERE safety_form_id = ? ORDER BY id ASC
    `).all(sub.id);

    let parsed = {};
    try { parsed = sub.data ? JSON.parse(sub.data) : {}; } catch (_) {}

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage();

    drawHeader(doc, sub);
    drawHeaderBand(doc, sub);
    drawAnswers(doc, parsed);
    drawPhotos(doc, photos);
    drawSignature(doc, sub);

    doc.end();
  });
}

module.exports = { renderSubmissionPdf };
