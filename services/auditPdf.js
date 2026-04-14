/**
 * Audit PDF export v4 — branded T&S Traffic Control.
 * Clean stacked layout, no overlapping, no blank pages.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, normaliseState } = require('../lib/auditQuestions');

const BRAND = '#1D6AE5';
const GREEN = '#059669';
const RED = '#DC2626';
const AMBER = '#D97706';
const GRAY = '#6B7280';
const GRAY_DARK = '#374151';
const GRAY_LIGHT = '#F3F4F6';
const WHITE = '#FFFFFF';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 45, MR = 45, MT = 40, MB = 45;

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }); }
  catch (e) { return String(d); }
}
function findingLabel(f) {
  if (f === 'pass') return 'PASS';
  if (f === 'pass_with_actions') return 'PASS WITH ACTIONS';
  if (f === 'fail') return 'FAIL';
  return (f || '—').toUpperCase();
}
function findingColor(f) {
  if (f === 'pass') return GREEN;
  if (f === 'fail') return RED;
  return AMBER;
}

function generateAuditPdf(opts, out) {
  const { audit: a, responses, sectionComments, nonconformances,
    score, attachmentsByContext } = opts;
  const ctxMap = attachmentsByContext || {};

  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: MT, bottom: MB, left: ML, right: MR },
    info: {
      Title: `Site Audit #${a.id} — ${a.project_site || 'Untitled'}`,
      Author: 'T&S Traffic Control',
    },
  });
  doc.pipe(out);

  const pw = doc.page.width - ML - MR;
  const pageBot = doc.page.height - MB;

  function Y() { return doc.y; }
  function setY(y) { doc.y = y; doc.x = ML; }
  function gap(n) { doc.y += n; }
  function need(h) { if (doc.y + h > pageBot) doc.addPage(); }
  function rr(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }
  // All text uses lineBreak:false to prevent phantom pages
  function T(size, color, str, x, y, w, opts2) {
    doc.fontSize(size).fillColor(color).text(str || '—', x, y,
      Object.assign({ lineBreak: false, width: w }, opts2 || {}));
  }

  // ==== HEADER ====
  const logoH = 36;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: logoH }); } catch (e) {}
  }
  T(15, BRAND, 'Site Safety Audit Report', ML + 130, MT + 2, pw - 130);
  T(7.5, GRAY, `Audit #${a.id}  ·  ${fmtDate(a.audit_datetime || a.created_at)}`, ML + 130, MT + 20, pw - 130);
  T(7.5, GRAY, 'T&S Traffic Control', ML + 130, MT + 30, pw - 130);

  setY(MT + logoH + 6);
  doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor(BRAND).lineWidth(1.5).stroke().restore();
  gap(10);

  // ==== SCORE ROW — score box left, finding badge right ====
  const bandY = Y();
  const sBoxW = 95, sBoxH = 45;

  rr(ML, bandY, sBoxW, sBoxH, 5, BRAND);
  T(6, WHITE, 'OVERALL SCORE', ML + 8, bandY + 4, sBoxW - 16);
  T(24, WHITE, `${score.percent}%`, ML + 8, bandY + 12, sBoxW - 16);
  T(6, WHITE, `${score.total}/${score.max} passed`, ML + 8, bandY + 36, sBoxW - 16);

  const fX = ML + sBoxW + 8;
  const fW = pw - sBoxW - 8;
  rr(fX, bandY, fW, 18, 3, findingColor(a.overall_finding));
  T(9, WHITE, findingLabel(a.overall_finding), fX + 8, bandY + 4, fW - 16);

  setY(bandY + sBoxH + 6);

  // ==== AREA SCORES — own row, full width, 4 columns ====
  const aY = Y();
  rr(ML, aY, pw, 24, 3, GRAY_LIGHT);
  const aCols = 4;
  const aColW = pw / aCols;
  score.groups.forEach(function (g, i) {
    const col = i % aCols;
    const row = Math.floor(i / aCols);
    const ax = ML + col * aColW + 4;
    const ay = aY + 3 + row * 11;
    T(5.5, GRAY, g.label, ax, ay, aColW - 50);
    T(6, GRAY_DARK, `${g.score}/${g.max} (${g.percent}%)`, ax + aColW - 54, ay, 50, { align: 'right' });
  });
  setY(aY + 28);
  gap(4);

  // ==== DETAILS — 2-col grid, label left-aligned, value right ====
  const details = [
    ['PROJECT / SITE', a.project_site],
    ['DATE', fmtDate(a.audit_datetime || a.created_at)],
    ['CLIENT', a.client],
    ['JOB #', a.job_number || '—'],
    ['LOCATION', a.location],
    ['SHIFT', (a.shift || '—').charAt(0).toUpperCase() + (a.shift || '').slice(1)],
    ['TGS / TCP REF', a.tgs_ref],
    ['WEATHER', a.weather],
    ['AUDITOR', a.auditor_name || a.created_by_name],
    ['SUPERVISOR', a.supervisor_name],
  ];
  const dColW = pw / 2;
  const lblW = 65;
  const dY = Y();
  details.forEach(function (d, i) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const dx = ML + col * dColW;
    const dy = dY + row * 12;
    T(5.5, GRAY, d[0], dx, dy, lblW);
    T(7, GRAY_DARK, d[1], dx + lblW + 2, dy, dColW - lblW - 6);
  });
  setY(dY + Math.ceil(details.length / 2) * 12 + 2);

  // Status line
  T(5.5, GRAY, 'STATUS', ML, Y(), lblW);
  T(7, GRAY_DARK, (a.status || 'draft').replace('_', ' ').toUpperCase(), ML + lblW + 2, Y(), dColW - lblW);
  gap(10);
  if (a.follow_up_required) {
    T(6, AMBER, 'FOLLOW-UP REQUIRED: ' + (a.follow_up_date || 'TBC'), ML, Y(), pw);
    gap(10);
  }

  doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor('#E5E7EB').lineWidth(0.5).stroke().restore();
  gap(6);

  // ==== Site overview evidence ====
  embedImages(doc, a, ctxMap['overview'], 'SITE OVERVIEW EVIDENCE', pw, pageBot);

  // ==== CHECKLIST SECTIONS ====
  AUDIT_SECTIONS.forEach(function (section) {
    need(30);
    const hY = Y();
    rr(ML, hY, pw, 16, 3, BRAND);
    T(8, WHITE, `${section.key}. ${section.title}`, ML + 6, hY + 3, pw - 56);
    let sYes = 0, sMax = 0;
    section.items.forEach(function (_, idx) {
      const st = normaliseState(responses[section.key + '.' + (idx + 1)]);
      if (st === 'yes') { sYes++; sMax++; } else if (st === 'no') { sMax++; }
    });
    T(7, WHITE, `${sYes}/${sMax}`, ML + pw - 42, hY + 4, 36, { align: 'right' });
    setY(hY + 19);

    section.items.forEach(function (item, idx) {
      const key = section.key + '.' + (idx + 1);
      const r = responses[key] || {};
      const st = normaliseState(r);
      need(11);

      const iy = Y();
      if (idx % 2 === 0) doc.save().rect(ML, iy - 1, pw, 10).fill(GRAY_LIGHT).restore();

      let badge, bc;
      if (st === 'yes') { badge = 'YES'; bc = GREEN; }
      else if (st === 'no') { badge = 'NO'; bc = RED; }
      else if (st === 'na') { badge = 'N/A'; bc = GRAY; }
      else { badge = '—'; bc = '#D1D5DB'; }
      rr(ML + 1, iy, 21, 8, 2, bc);
      T(5, WHITE, badge, ML + 2, iy + 1.5, 19, { align: 'center' });
      T(6.5, GRAY_DARK, `${key}  ${item}`, ML + 25, iy + 1, pw - 28, { height: 8, ellipsis: true });
      setY(iy + 10);

      if (r.notes) {
        need(10);
        // Italic note text to distinguish from item text
        doc.font('Helvetica-Oblique').fontSize(5.5).fillColor('#4B5563')
          .text(`→ ${r.notes}`, ML + 25, Y(), { width: pw - 28, lineBreak: false, height: 7, ellipsis: true });
        doc.font('Helvetica');
        gap(8);
      }
    });

    // Section comments — visible blue box, multi-line
    if (sectionComments[section.key]) {
      const cmtText = sectionComments[section.key];
      // Measure height needed (approx 7pt font ~= 9px per line, ~80 chars per line at pw-20)
      const charsPerLine = Math.floor((pw - 20) / 3.5);
      const lines = Math.max(1, Math.ceil(cmtText.length / charsPerLine));
      const boxH = 12 + lines * 9;
      need(boxH + 2);
      const cy = Y();
      rr(ML, cy, pw, boxH, 3, '#EFF6FF');
      doc.save().roundedRect(ML, cy, 3, boxH, 1).fill(BRAND).restore();
      T(5.5, BRAND, 'COMMENTS', ML + 8, cy + 3, 50);
      // Use lineBreak:true for multi-line comments
      doc.fontSize(7).fillColor(GRAY_DARK).text(cmtText, ML + 8, cy + 12, { width: pw - 20, lineBreak: true });
      setY(cy + boxH + 2);
    }

    embedImages(doc, a, ctxMap['section_' + section.key], null, pw, pageBot);
    gap(3);
  });

  // ==== NON-CONFORMANCE REGISTER ====
  if (nonconformances && nonconformances.length) {
    need(35);
    const ncY = Y();
    rr(ML, ncY, pw, 16, 3, RED);
    T(8, WHITE, 'Non-Conformance Register', ML + 6, ncY + 3, pw - 16);
    setY(ncY + 19);

    const ncW = [14, 0, 32, 0, 46, 40, 24];
    const flex = Math.floor((pw - 14 - 32 - 46 - 40 - 24) / 2);
    ncW[1] = flex; ncW[3] = flex;

    let cx = ML;
    ['#', 'Issue', 'Risk', 'Action', 'Resp.', 'Due', 'Done'].forEach(function (h, i) {
      T(5, GRAY, h, cx, Y(), ncW[i]);
      cx += ncW[i];
    });
    gap(8);

    nonconformances.forEach(function (nc, i) {
      need(10);
      const ry = Y();
      if (i % 2 === 0) doc.save().rect(ML, ry - 1, pw, 9).fill(GRAY_LIGHT).restore();
      cx = ML;
      [String(i + 1), nc.issue || '', nc.risk || '—', nc.action || '—', nc.responsible || '—', nc.due_date || '—', nc.closed ? '✓' : '—'].forEach(function (v, vi) {
        T(5.5, GRAY_DARK, v, cx, ry, ncW[vi], { height: 8, ellipsis: true });
        cx += ncW[vi];
      });
      setY(ry + 9);
      embedImages(doc, a, ctxMap['nc_' + (i + 1)], null, pw, pageBot);
    });
    gap(4);
  }

  // ==== SIGNATURES (styled like the web — large italic like a real signature) ====
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    need(60);
    doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor(BRAND).lineWidth(1).stroke().restore();
    gap(4);
    T(8, BRAND, 'Sign-off', ML, Y(), pw);
    gap(10);
    const sY = Y();
    const sW = (pw - 12) / 2;

    function drawSigBox(x, label, name, signedAt) {
      rr(x, sY, sW, 48, 4, GRAY_LIGHT);
      // Subtle bottom border like the web cards
      doc.save().moveTo(x, sY + 48).lineTo(x + sW, sY + 48).strokeColor('#D1D5DB').lineWidth(0.5).stroke().restore();
      T(5.5, GRAY, label, x + 8, sY + 5, sW - 16);
      // Signature name — large italic (Helvetica-Oblique)
      doc.font('Helvetica-Oblique').fontSize(18).fillColor(GRAY_DARK)
        .text(name, x + 8, sY + 16, { width: sW - 16, lineBreak: false });
      doc.font('Helvetica'); // reset font
      if (signedAt) {
        T(5.5, GREEN, '✓ Signed ' + fmtDate(signedAt), x + 8, sY + 38, sW - 16);
      }
    }

    if (a.auditor_signature_text) {
      drawSigBox(ML, 'AUDITOR', a.auditor_signature_text, a.auditor_signed_at);
    }
    if (a.supervisor_signature_text) {
      drawSigBox(ML + sW + 12, 'SUPERVISOR / STMS', a.supervisor_signature_text, a.supervisor_signed_at);
    }
    setY(sY + 54);
  }

  // Annotated TGS
  embedImages(doc, a, ctxMap['annotated_tgs'], 'ANNOTATED TGS / CLOSE-OUT SKETCH', pw, pageBot);

  // ==== FOOTER INFO — created by, signed off by ====
  gap(8);
  doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor('#E5E7EB').lineWidth(0.5).stroke().restore();
  gap(4);
  T(5.5, GRAY, 'Created by ' + (a.created_by_name || '—') + '  ·  ' + fmtDate(a.created_at), ML, Y(), pw);
  gap(8);
  if (a.signed_off_by_name) {
    rr(ML, Y(), pw, 16, 3, '#F0FDF4');
    doc.save().roundedRect(ML, Y(), 3, 16, 1).fill(GREEN).restore();
    T(5.5, GREEN, 'INTERNALLY SIGNED OFF BY', ML + 8, Y() + 2, 110);
    T(7, GRAY_DARK, a.signed_off_by_name + '  ·  ' + fmtDate(a.signed_off_at), ML + 120, Y() + 2, pw - 128);
    gap(20);
  }

  // ==== PAGE NUMBERS ====
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    T(5, GRAY, `T&S Traffic Control  ·  Site Audit #${a.id}  ·  Page ${i + 1} of ${range.count}`,
      ML, doc.page.height - 28, pw, { align: 'center' });
  }

  doc.end();
}

/**
 * Embed image thumbnails in a grid. Safe page breaks, no blank pages.
 */
function embedImages(doc, audit, items, label, pw, pageBot) {
  if (!items || !items.length) return;
  const images = [];
  items.forEach(function (att) {
    if (!(att.mime_type || '').startsWith('image/')) return;
    const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    if (fs.existsSync(fp)) images.push({ att: att, fp: fp });
  });
  if (!images.length) return;

  if (label) {
    if (doc.y + 14 > pageBot) doc.addPage();
    doc.fontSize(5.5).fillColor(GRAY).text(label, ML, doc.y, { lineBreak: false });
    doc.y += 6;
  }

  const tw = 85, th = 64, gx = 4, gy = 4;
  const cols = Math.floor((pw + gx) / (tw + gx));
  let col = 0, rowY = doc.y;

  images.forEach(function (img) {
    if (col >= cols) { col = 0; rowY += th + gy; }
    if (col === 0 && rowY + th > pageBot) { doc.addPage(); rowY = doc.y; }
    try { doc.image(img.fp, ML + col * (tw + gx), rowY, { fit: [tw, th], align: 'center', valign: 'center' }); }
    catch (e) { /* skip */ }
    col++;
  });
  doc.y = rowY + th + gy;
  doc.x = ML;
}

module.exports = { generateAuditPdf };
