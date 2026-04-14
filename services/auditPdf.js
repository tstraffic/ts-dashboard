/**
 * Audit PDF export — branded T&S Traffic Control PDF using PDFKit.
 * Compact, professional layout: header/logo, score card, details grid,
 * 11 checklist sections with badges, NC register, signatures, evidence photos.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, normaliseState } = require('../lib/auditQuestions');

// Brand palette
const BRAND = '#1D6AE5';
const GREEN = '#059669';
const RED = '#DC2626';
const AMBER = '#D97706';
const GRAY = '#6B7280';
const GRAY_DARK = '#374151';
const GRAY_LIGHT = '#F3F4F6';
const WHITE = '#FFFFFF';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 45; // margin left
const MR = 45; // margin right
const MT = 40; // margin top
const MB = 50; // margin bottom

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

/**
 * @param {object} opts — { audit, responses, sectionComments, nonconformances,
 *   score, attachments, attachmentsByContext }
 * @param {stream.Writable} out
 */
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

  const pw = doc.page.width - ML - MR; // printable width

  // ---- Helpers ----
  function Y() { return doc.y; }
  function moveTo(y) { doc.y = y; doc.x = ML; }
  function space(n) { doc.y += n; }
  function needSpace(h) {
    if (doc.y + h > doc.page.height - MB) { doc.addPage(); addFooter(); }
  }
  function hr(color, width) {
    doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y())
      .strokeColor(color || '#E5E7EB').lineWidth(width || 0.5).stroke().restore();
    space(1);
  }
  function roundRect(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }
  // Small text helper — writes text and returns new Y
  function txt(str, x, y, opts2) {
    doc.text(str || '', x, y, Object.assign({ lineBreak: true }, opts2));
    return doc.y;
  }
  // Footer on current page
  function addFooter() {
    // Will be overwritten with page numbers at end
  }

  // ============================================================
  // PAGE 1 HEADER
  // ============================================================
  const logoH = 40;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: logoH }); } catch (e) {}
  }
  // Title block right of logo
  const titleX = ML + 140;
  doc.fontSize(16).fillColor(BRAND).text('Site Safety Audit', titleX, MT + 2, { width: pw - 140 });
  doc.fontSize(8).fillColor(GRAY).text(`Audit #${a.id}  ·  ${fmtDate(a.audit_datetime || a.created_at)}`, titleX, MT + 22);
  doc.fontSize(8).fillColor(GRAY).text('T&S Traffic Control', titleX, MT + 32);

  moveTo(MT + logoH + 8);
  doc.save().moveTo(ML, Y()).lineTo(ML + pw, Y()).strokeColor(BRAND).lineWidth(1.5).stroke().restore();
  space(10);

  // ---- SCORE CARD (compact: score box + finding + area bars in one row) ----
  const scoreY = Y();
  // Blue score box
  const sBoxW = 110, sBoxH = 60;
  roundRect(ML, scoreY, sBoxW, sBoxH, 5, BRAND);
  doc.fontSize(7).fillColor(WHITE).text('OVERALL SCORE', ML + 8, scoreY + 6, { width: sBoxW - 16 });
  doc.fontSize(28).fillColor(WHITE).text(`${score.percent}%`, ML + 8, scoreY + 16, { width: sBoxW - 16 });
  doc.fontSize(7).fillColor(WHITE).text(`${score.total}/${score.max} passed`, ML + 8, scoreY + 47, { width: sBoxW - 16 });

  // Finding pill
  const fX = ML + sBoxW + 10;
  const fW = 120;
  roundRect(fX, scoreY, fW, 20, 4, findingColor(a.overall_finding));
  doc.fontSize(8).fillColor(WHITE).text(findingLabel(a.overall_finding), fX + 6, scoreY + 5, { width: fW - 12 });

  // Per-area scores (compact list)
  const areaX = fX;
  let areaY = scoreY + 26;
  score.groups.forEach(function (g) {
    doc.fontSize(6.5).fillColor(GRAY).text(g.label, areaX, areaY, { width: 105, continued: false });
    doc.fontSize(6.5).fillColor(GRAY_DARK).text(`${g.score}/${g.max} (${g.percent}%)`, areaX + 108, areaY, { width: 60 });
    areaY += 9;
  });

  // Status + follow-up (top-right area)
  const statusX = ML + sBoxW + fW + 20;
  if (statusX + 100 < ML + pw) {
    doc.fontSize(7).fillColor(GRAY).text('STATUS', statusX, scoreY, { width: 100 });
    doc.fontSize(9).fillColor(GRAY_DARK).text((a.status || 'draft').replace('_', ' ').toUpperCase(), statusX, scoreY + 9);
    if (a.follow_up_required) {
      doc.fontSize(7).fillColor(AMBER).text('Follow-up: ' + (a.follow_up_date || 'TBC'), statusX, scoreY + 22);
    }
  }

  moveTo(scoreY + sBoxH + 8);
  hr('#E5E7EB');
  space(4);

  // ---- AUDIT DETAILS (2-col compact grid) ----
  const details = [
    ['Client', a.client], ['Project / Site', a.project_site],
    ['Location', a.location], ['Job #', a.job_number || '—'],
    ['TGS / TCP Ref', a.tgs_ref], ['Shift', (a.shift || '—').charAt(0).toUpperCase() + (a.shift || '').slice(1)],
    ['Weather', a.weather], ['Auditor', a.auditor_name || a.created_by_name],
    ['Supervisor', a.supervisor_name], ['Date', fmtDate(a.audit_datetime || a.created_at)],
  ];
  const colW = pw / 2;
  const detY = Y();
  details.forEach(function (d, i) {
    const dx = ML + (i % 2) * colW;
    const dy = detY + Math.floor(i / 2) * 14;
    doc.fontSize(6).fillColor(GRAY).text(d[0].toUpperCase(), dx, dy);
    doc.fontSize(8).fillColor(GRAY_DARK).text(d[1] || '—', dx + 55, dy, { width: colW - 60 });
  });
  moveTo(detY + Math.ceil(details.length / 2) * 14 + 6);
  hr('#E5E7EB');
  space(4);

  // ---- Site overview evidence ----
  embedImageGrid(doc, a, ctxMap['overview'], 'SITE OVERVIEW EVIDENCE', pw);

  // ============================================================
  // CHECKLIST SECTIONS
  // ============================================================
  AUDIT_SECTIONS.forEach(function (section) {
    needSpace(40);
    // Section header
    const hY = Y();
    roundRect(ML, hY, pw, 18, 3, BRAND);
    doc.fontSize(9).fillColor(WHITE).text(`${section.key}. ${section.title}`, ML + 6, hY + 4, { width: pw - 60 });
    // Section score
    let sY = 0, sM = 0;
    section.items.forEach(function (_, idx) {
      const st = normaliseState(responses[section.key + '.' + (idx + 1)]);
      if (st === 'yes') { sY++; sM++; } else if (st === 'no') { sM++; }
    });
    doc.fontSize(8).fillColor(WHITE).text(`${sY}/${sM}`, ML + pw - 50, hY + 5, { width: 44, align: 'right' });
    moveTo(hY + 22);

    // Items
    section.items.forEach(function (item, idx) {
      const key = section.key + '.' + (idx + 1);
      const r = responses[key] || {};
      const st = normaliseState(r);
      needSpace(14);

      const iy = Y();
      // Stripe
      if (idx % 2 === 0) {
        doc.save().rect(ML, iy - 1, pw, 12).fill(GRAY_LIGHT).restore();
      }
      // Badge
      let badge, bc;
      if (st === 'yes') { badge = 'YES'; bc = GREEN; }
      else if (st === 'no') { badge = 'NO'; bc = RED; }
      else if (st === 'na') { badge = 'N/A'; bc = GRAY; }
      else { badge = '—'; bc = '#D1D5DB'; }
      roundRect(ML + 1, iy, 24, 10, 2, bc);
      doc.fontSize(6).fillColor(WHITE).text(badge, ML + 2, iy + 2, { width: 22, align: 'center' });

      // Item text (single line, truncate if needed)
      const maxTextW = pw - 32;
      doc.fontSize(7).fillColor(GRAY_DARK).text(`${key}  ${item}`, ML + 28, iy + 1, { width: maxTextW, height: 10, ellipsis: true });
      moveTo(iy + 12);

      // Notes on next line if present
      if (r.notes) {
        needSpace(10);
        doc.fontSize(6).fillColor(GRAY).text(`→ ${r.notes}`, ML + 28, Y(), { width: maxTextW });
        space(2);
      }
    });

    // Section comments
    if (sectionComments[section.key]) {
      needSpace(16);
      doc.fontSize(6).fillColor(GRAY).text('COMMENTS: ', ML + 2, Y(), { continued: true });
      doc.fontSize(7).fillColor(GRAY_DARK).text(sectionComments[section.key]);
      space(2);
    }

    // Per-section evidence
    embedImageGrid(doc, a, ctxMap['section_' + section.key], `SECTION ${section.key} EVIDENCE`, pw);
    space(4);
  });

  // ============================================================
  // NON-CONFORMANCE REGISTER
  // ============================================================
  if (nonconformances && nonconformances.length) {
    needSpace(50);
    const ncY = Y();
    roundRect(ML, ncY, pw, 18, 3, RED);
    doc.fontSize(9).fillColor(WHITE).text('Non-Conformance Register', ML + 6, ncY + 4);
    moveTo(ncY + 22);

    // Column widths
    const ncW = [18, 0, 40, 0, 55, 48, 30];
    const flex = Math.floor((pw - 18 - 40 - 55 - 48 - 30) / 2);
    ncW[1] = flex; ncW[3] = flex;
    const ncH = ['#', 'Issue', 'Risk', 'Action', 'Resp.', 'Due', 'Done'];

    // Header row
    let cx = ML;
    ncH.forEach(function (h, i) {
      doc.fontSize(6).fillColor(GRAY).text(h, cx, Y(), { width: ncW[i] });
      cx += ncW[i];
    });
    space(10);

    nonconformances.forEach(function (nc, i) {
      needSpace(14);
      const ry = Y();
      if (i % 2 === 0) doc.save().rect(ML, ry - 1, pw, 12).fill(GRAY_LIGHT).restore();
      cx = ML;
      const vals = [String(i + 1), nc.issue || '', nc.risk || '—', nc.action || '—', nc.responsible || '—', nc.due_date || '—', nc.closed ? '✓' : '—'];
      vals.forEach(function (v, vi) {
        doc.fontSize(6.5).fillColor(GRAY_DARK).text(v, cx, ry + 1, { width: ncW[vi], height: 10, ellipsis: true });
        cx += ncW[vi];
      });
      moveTo(ry + 12);

      // Per-NC evidence
      embedImageGrid(doc, a, ctxMap['nc_' + (i + 1)], null, pw);
    });
    space(6);
  }

  // ============================================================
  // SIGNATURES
  // ============================================================
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    needSpace(55);
    hr(BRAND, 1);
    space(4);
    doc.fontSize(9).fillColor(BRAND).text('Sign-off', ML, Y());
    space(8);
    const sigY = Y();
    const sigW = (pw - 10) / 2;

    if (a.auditor_signature_text) {
      roundRect(ML, sigY, sigW, 40, 3, GRAY_LIGHT);
      doc.fontSize(6).fillColor(GRAY).text('AUDITOR', ML + 6, sigY + 4);
      doc.fontSize(14).fillColor(GRAY_DARK).text(a.auditor_signature_text, ML + 6, sigY + 14, { width: sigW - 12 });
      if (a.auditor_signed_at) {
        doc.fontSize(5.5).fillColor(GREEN).text('Signed ' + fmtDate(a.auditor_signed_at), ML + 6, sigY + 32);
      }
    }
    if (a.supervisor_signature_text) {
      const sx = ML + sigW + 10;
      roundRect(sx, sigY, sigW, 40, 3, GRAY_LIGHT);
      doc.fontSize(6).fillColor(GRAY).text('SUPERVISOR / STMS', sx + 6, sigY + 4);
      doc.fontSize(14).fillColor(GRAY_DARK).text(a.supervisor_signature_text, sx + 6, sigY + 14, { width: sigW - 12 });
      if (a.supervisor_signed_at) {
        doc.fontSize(5.5).fillColor(GREEN).text('Signed ' + fmtDate(a.supervisor_signed_at), sx + 6, sigY + 32);
      }
    }
    moveTo(sigY + 46);
  }

  // Annotated TGS
  embedImageGrid(doc, a, ctxMap['annotated_tgs'], 'ANNOTATED TGS / CLOSE-OUT SKETCH', pw);

  // ---- Sign-off metadata ----
  needSpace(30);
  space(4);
  hr('#E5E7EB');
  space(4);
  doc.fontSize(6).fillColor(GRAY).text(`Created by ${a.created_by_name || '—'} · ${fmtDate(a.created_at)}`, ML, Y());
  if (a.signed_off_by_name) {
    doc.fontSize(6).fillColor(GRAY).text(`Signed off by ${a.signed_off_by_name} · ${fmtDate(a.signed_off_at)}`);
  }

  // ============================================================
  // PAGE NUMBERS (iterate all pages)
  // ============================================================
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(6).fillColor(GRAY).text(
      `T&S Traffic Control  ·  Site Audit #${a.id}  ·  Page ${i + 1} of ${range.count}`,
      ML, doc.page.height - 30,
      { width: pw, align: 'center' }
    );
  }

  doc.end();
}

/**
 * Embed a grid of image thumbnails from an attachments array.
 * Only embeds actual image files (skips PDFs, docs, missing files).
 * Carefully manages page breaks to avoid blank pages.
 */
function embedImageGrid(doc, audit, items, label, pw) {
  if (!items || !items.length) return;
  const images = items.filter(function (att) {
    if (!(att.mime_type || '').startsWith('image/')) return false;
    const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    return fs.existsSync(fp);
  });
  if (!images.length) return;

  if (label) {
    if (doc.y + 20 > doc.page.height - MB) doc.addPage();
    doc.fontSize(6).fillColor(GRAY).text(label, ML, doc.y);
    doc.y += 2;
  }

  const thumbW = 100, thumbH = 75, gap = 6;
  const cols = Math.floor((pw + gap) / (thumbW + gap));

  images.forEach(function (att, i) {
    const col = i % cols;
    if (col === 0 && i > 0) doc.y += thumbH + gap; // next row
    if (col === 0 && doc.y + thumbH + gap > doc.page.height - MB) doc.addPage();

    const x = ML + col * (thumbW + gap);
    const y = doc.y;
    const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    try {
      doc.image(fp, x, y, { fit: [thumbW, thumbH], align: 'center', valign: 'center' });
    } catch (e) { /* skip corrupt/unsupported */ }
  });

  // Move past the last row
  doc.y += thumbH + gap;
  doc.x = ML;
}

module.exports = { generateAuditPdf };
