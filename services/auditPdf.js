/**
 * Audit PDF export — branded T&S Traffic Control PDF using PDFKit.
 * Clean stacked layout: header → score → details → checklist → NC → signatures.
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
  const pageBottom = doc.page.height - MB;

  // helpers
  function Y() { return doc.y; }
  function setY(y) { doc.y = y; doc.x = ML; }
  function gap(n) { doc.y += n; }
  function needSpace(h) { if (doc.y + h > pageBottom) doc.addPage(); }
  function hr(c, w) {
    doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor(c || '#E5E7EB').lineWidth(w || 0.5).stroke().restore();
    gap(1);
  }
  function rr(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }

  // ============================================================
  // HEADER — logo left, title right
  // ============================================================
  const logoH = 36;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: logoH }); } catch (e) {}
  }
  doc.fontSize(15).fillColor(BRAND).text('Site Safety Audit Report', ML + 130, MT + 2, { width: pw - 130, lineBreak: false });
  doc.fontSize(7.5).fillColor(GRAY).text(`Audit #${a.id}  ·  ${fmtDate(a.audit_datetime || a.created_at)}`, ML + 130, MT + 20, { lineBreak: false });
  doc.fontSize(7.5).fillColor(GRAY).text('T&S Traffic Control', ML + 130, MT + 30, { lineBreak: false });

  setY(MT + logoH + 6);
  doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor(BRAND).lineWidth(1.5).stroke().restore();
  gap(10);

  // ============================================================
  // SCORE BAND — score box left, finding right (one row, clean)
  // ============================================================
  const bandY = Y();
  const sBoxW = 100, sBoxH = 50;

  // Blue score box
  rr(ML, bandY, sBoxW, sBoxH, 5, BRAND);
  doc.fontSize(6.5).fillColor(WHITE).text('OVERALL SCORE', ML + 8, bandY + 5, { width: sBoxW - 16, lineBreak: false });
  doc.fontSize(26).fillColor(WHITE).text(`${score.percent}%`, ML + 8, bandY + 14, { width: sBoxW - 16, lineBreak: false });
  doc.fontSize(6.5).fillColor(WHITE).text(`${score.total}/${score.max} passed`, ML + 8, bandY + 40, { width: sBoxW - 16, lineBreak: false });

  // Finding badge
  const fX = ML + sBoxW + 10;
  const fW = pw - sBoxW - 10;
  rr(fX, bandY, fW, 18, 3, findingColor(a.overall_finding));
  doc.fontSize(9).fillColor(WHITE).text(findingLabel(a.overall_finding), fX + 8, bandY + 4, { width: fW - 16, lineBreak: false });

  // Area scores — in a clean 2-col grid below the finding badge
  let aY = bandY + 24;
  const aColW = fW / 2;
  score.groups.forEach(function (g, i) {
    const ax = fX + (i % 2) * aColW;
    const ay = aY + Math.floor(i / 2) * 10;
    doc.fontSize(6).fillColor(GRAY).text(g.label, ax, ay, { width: aColW - 45, lineBreak: false });
    doc.fontSize(6).fillColor(GRAY_DARK).text(`${g.score}/${g.max} (${g.percent}%)`, ax + aColW - 52, ay, { width: 50, align: 'right', lineBreak: false });
  });

  setY(bandY + sBoxH + 8);
  hr('#E5E7EB');
  gap(4);

  // ============================================================
  // AUDIT DETAILS — clean 2-col label : value
  // ============================================================
  const details = [
    ['Project / Site', a.project_site],
    ['Date', fmtDate(a.audit_datetime || a.created_at)],
    ['Client', a.client],
    ['Job #', a.job_number || '—'],
    ['Location', a.location],
    ['Shift', (a.shift || '—').charAt(0).toUpperCase() + (a.shift || '').slice(1)],
    ['TGS / TCP Ref', a.tgs_ref],
    ['Weather', a.weather],
    ['Auditor', a.auditor_name || a.created_by_name],
    ['Supervisor', a.supervisor_name],
  ];
  const dColW = pw / 2;
  const dStartY = Y();
  details.forEach(function (d, i) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const dx = ML + col * dColW;
    const dy = dStartY + row * 13;
    doc.fontSize(6).fillColor(GRAY).text(d[0].toUpperCase(), dx, dy, { lineBreak: false });
    doc.fontSize(7.5).fillColor(GRAY_DARK).text(d[1] || '—', dx + 62, dy, { width: dColW - 66, lineBreak: false });
  });
  setY(dStartY + Math.ceil(details.length / 2) * 13 + 4);

  // Status + created / signed-off
  doc.fontSize(6).fillColor(GRAY).text('STATUS', ML, Y(), { lineBreak: false });
  doc.fontSize(7.5).fillColor(GRAY_DARK).text((a.status || 'draft').replace('_', ' ').toUpperCase(), ML + 62, Y(), { lineBreak: false });
  gap(11);
  if (a.follow_up_required) {
    doc.fontSize(6).fillColor(AMBER).text('FOLLOW-UP REQUIRED: ' + (a.follow_up_date || 'TBC'), ML, Y(), { lineBreak: false });
    gap(10);
  }

  hr('#E5E7EB');
  gap(4);

  // ---- Site overview evidence ----
  embedImageGrid(doc, a, ctxMap['overview'], 'SITE OVERVIEW EVIDENCE', pw, pageBottom);

  // ============================================================
  // CHECKLIST SECTIONS
  // ============================================================
  AUDIT_SECTIONS.forEach(function (section) {
    needSpace(36);
    // Section header bar
    const hY = Y();
    rr(ML, hY, pw, 16, 3, BRAND);
    doc.fontSize(8.5).fillColor(WHITE).text(`${section.key}. ${section.title}`, ML + 6, hY + 3, { width: pw - 56, lineBreak: false });
    let sYes = 0, sMax = 0;
    section.items.forEach(function (_, idx) {
      const st = normaliseState(responses[section.key + '.' + (idx + 1)]);
      if (st === 'yes') { sYes++; sMax++; } else if (st === 'no') { sMax++; }
    });
    doc.fontSize(7).fillColor(WHITE).text(`${sYes}/${sMax}`, ML + pw - 44, hY + 4, { width: 38, align: 'right', lineBreak: false });
    setY(hY + 19);

    // Items
    section.items.forEach(function (item, idx) {
      const key = section.key + '.' + (idx + 1);
      const r = responses[key] || {};
      const st = normaliseState(r);
      needSpace(12);

      const iy = Y();
      if (idx % 2 === 0) doc.save().rect(ML, iy - 1, pw, 11).fill(GRAY_LIGHT).restore();

      // Badge
      let badge, bc;
      if (st === 'yes') { badge = 'YES'; bc = GREEN; }
      else if (st === 'no') { badge = 'NO'; bc = RED; }
      else if (st === 'na') { badge = 'N/A'; bc = GRAY; }
      else { badge = '—'; bc = '#D1D5DB'; }
      rr(ML + 1, iy, 22, 9, 2, bc);
      doc.fontSize(5.5).fillColor(WHITE).text(badge, ML + 2, iy + 2, { width: 20, align: 'center', lineBreak: false });

      // Item text
      doc.fontSize(6.5).fillColor(GRAY_DARK).text(`${key}  ${item}`, ML + 26, iy + 1, { width: pw - 30, height: 9, ellipsis: true, lineBreak: false });
      setY(iy + 11);

      if (r.notes) {
        needSpace(9);
        doc.fontSize(5.5).fillColor(GRAY).text(`→ ${r.notes}`, ML + 26, Y(), { width: pw - 30, height: 8, ellipsis: true, lineBreak: false });
        gap(9);
      }
    });

    if (sectionComments[section.key]) {
      needSpace(18);
      const cmtY = Y();
      // Light blue background to make comments stand out
      const cmtText = sectionComments[section.key];
      const cmtH = 16;
      rr(ML, cmtY, pw, cmtH, 3, '#EFF6FF');
      doc.save().roundedRect(ML, cmtY, 3, cmtH, 1).fill(BRAND).restore(); // left accent bar
      doc.fontSize(5.5).fillColor(BRAND).text('COMMENTS', ML + 8, cmtY + 2, { lineBreak: false });
      doc.fontSize(7).fillColor(GRAY_DARK).text(cmtText, ML + 8, cmtY + 8, { width: pw - 16, height: 8, ellipsis: true, lineBreak: false });
      setY(cmtY + cmtH + 2);
    }

    embedImageGrid(doc, a, ctxMap['section_' + section.key], null, pw, pageBottom);
    gap(3);
  });

  // ============================================================
  // NON-CONFORMANCE REGISTER
  // ============================================================
  if (nonconformances && nonconformances.length) {
    needSpace(40);
    const ncY = Y();
    rr(ML, ncY, pw, 16, 3, RED);
    doc.fontSize(8.5).fillColor(WHITE).text('Non-Conformance Register', ML + 6, ncY + 3, { lineBreak: false });
    setY(ncY + 20);

    const ncW = [16, 0, 36, 0, 50, 44, 26];
    const flex = Math.floor((pw - 16 - 36 - 50 - 44 - 26) / 2);
    ncW[1] = flex; ncW[3] = flex;
    const ncH = ['#', 'Issue', 'Risk', 'Action', 'Resp.', 'Due', 'Done'];

    let cx = ML;
    ncH.forEach(function (h, i) {
      doc.fontSize(5.5).fillColor(GRAY).text(h, cx, Y(), { width: ncW[i], lineBreak: false });
      cx += ncW[i];
    });
    gap(9);

    nonconformances.forEach(function (nc, i) {
      needSpace(11);
      const ry = Y();
      if (i % 2 === 0) doc.save().rect(ML, ry - 1, pw, 10).fill(GRAY_LIGHT).restore();
      cx = ML;
      [String(i + 1), nc.issue || '', nc.risk || '—', nc.action || '—', nc.responsible || '—', nc.due_date || '—', nc.closed ? '✓' : '—'].forEach(function (v, vi) {
        doc.fontSize(6).fillColor(GRAY_DARK).text(v, cx, ry, { width: ncW[vi], height: 9, ellipsis: true, lineBreak: false });
        cx += ncW[vi];
      });
      setY(ry + 10);
      embedImageGrid(doc, a, ctxMap['nc_' + (i + 1)], null, pw, pageBottom);
    });
    gap(4);
  }

  // ============================================================
  // SIGNATURES
  // ============================================================
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    needSpace(50);
    hr(BRAND, 1);
    gap(3);
    doc.fontSize(8).fillColor(BRAND).text('Sign-off', ML, Y(), { lineBreak: false });
    gap(12);
    const sigY = Y();
    const sigW = (pw - 10) / 2;

    if (a.auditor_signature_text) {
      rr(ML, sigY, sigW, 36, 3, GRAY_LIGHT);
      doc.fontSize(5.5).fillColor(GRAY).text('AUDITOR', ML + 6, sigY + 3, { lineBreak: false });
      doc.fontSize(13).fillColor(GRAY_DARK).text(a.auditor_signature_text, ML + 6, sigY + 12, { width: sigW - 12, lineBreak: false });
      if (a.auditor_signed_at) doc.fontSize(5).fillColor(GREEN).text('Signed ' + fmtDate(a.auditor_signed_at), ML + 6, sigY + 28, { lineBreak: false });
    }
    if (a.supervisor_signature_text) {
      const sx = ML + sigW + 10;
      rr(sx, sigY, sigW, 36, 3, GRAY_LIGHT);
      doc.fontSize(5.5).fillColor(GRAY).text('SUPERVISOR / STMS', sx + 6, sigY + 3, { lineBreak: false });
      doc.fontSize(13).fillColor(GRAY_DARK).text(a.supervisor_signature_text, sx + 6, sigY + 12, { width: sigW - 12, lineBreak: false });
      if (a.supervisor_signed_at) doc.fontSize(5).fillColor(GREEN).text('Signed ' + fmtDate(a.supervisor_signed_at), sx + 6, sigY + 28, { lineBreak: false });
    }
    setY(sigY + 40);
  }

  // Annotated TGS
  embedImageGrid(doc, a, ctxMap['annotated_tgs'], 'ANNOTATED TGS / CLOSE-OUT SKETCH', pw, pageBottom);

  // ---- Metadata footer line ----
  gap(6);
  const metaText = ['Created by ' + (a.created_by_name || '—') + ' · ' + fmtDate(a.created_at)];
  if (a.signed_off_by_name) metaText.push('Signed off by ' + a.signed_off_by_name + ' · ' + fmtDate(a.signed_off_at));
  doc.fontSize(5.5).fillColor(GRAY).text(metaText.join('    |    '), ML, Y(), { width: pw, lineBreak: false });

  // ============================================================
  // PAGE NUMBERS — write into footer of each buffered page
  // ============================================================
  const range = doc.bufferedPageRange();
  const totalPages = range.count;
  for (let i = range.start; i < range.start + totalPages; i++) {
    doc.switchToPage(i);
    doc.fontSize(5.5).fillColor(GRAY).text(
      `T&S Traffic Control  ·  Site Audit #${a.id}  ·  Page ${i + 1} of ${totalPages}`,
      ML, doc.page.height - 28,
      { width: pw, align: 'center', lineBreak: false }
    );
  }

  doc.end();
}

/**
 * Embed image thumbnails in a grid. Skips non-images and missing files.
 * Uses lineBreak:false everywhere to prevent PDFKit creating extra pages.
 */
function embedImageGrid(doc, audit, items, label, pw, pageBottom) {
  if (!items || !items.length) return;
  const images = items.filter(function (att) {
    if (!(att.mime_type || '').startsWith('image/')) return false;
    const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    return fs.existsSync(fp);
  });
  if (!images.length) return;

  if (label) {
    if (doc.y + 16 > pageBottom) doc.addPage();
    doc.fontSize(5.5).fillColor(GRAY).text(label, ML, doc.y, { lineBreak: false });
    doc.y += 8;
  }

  const thumbW = 90, thumbH = 68, gapX = 5, gapY = 5;
  const cols = Math.floor((pw + gapX) / (thumbW + gapX));
  let col = 0;
  let rowY = doc.y;

  images.forEach(function (att) {
    if (col >= cols) { col = 0; rowY += thumbH + gapY; }
    if (col === 0 && rowY + thumbH > pageBottom) { doc.addPage(); rowY = doc.y; }

    const x = ML + col * (thumbW + gapX);
    const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    try { doc.image(fp, x, rowY, { fit: [thumbW, thumbH], align: 'center', valign: 'center' }); }
    catch (e) { /* skip */ }
    col++;
  });

  doc.y = rowY + thumbH + gapY;
  doc.x = ML;
}

module.exports = { generateAuditPdf };
