/**
 * Audit PDF export — branded PDF using PDFKit.
 * Includes: header/logo, audit details, per-section checklist with
 * Yes/No/N/A badges, scoring, non-conformances, signatures, and
 * embedded evidence photos.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, SCORE_GROUPS, computeScore, normaliseState } = require('../lib/auditQuestions');

const BRAND = '#2B7FFF';
const BRAND_DARK = '#1D6AE5';
const GREEN = '#059669';
const RED = '#DC2626';
const GRAY = '#6B7280';
const GRAY_LIGHT = '#F3F4F6';
const WHITE = '#FFFFFF';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  } catch (e) {
    return d;
  }
}

function findingLabel(f) {
  if (f === 'pass') return 'Pass';
  if (f === 'pass_with_actions') return 'Pass with Actions';
  if (f === 'fail') return 'Fail — Immediate Rectification';
  return f || '—';
}

function findingColor(f) {
  if (f === 'pass') return GREEN;
  if (f === 'fail') return RED;
  return '#D97706'; // amber
}

/**
 * Generate the audit PDF and pipe it to a writable stream (e.g. res).
 * @param {object} opts — { audit, responses, sectionComments, nonconformances,
 *   score, attachments, attachmentsByContext }
 * @param {stream.Writable} out — destination (typically Express res)
 */
function generateAuditPdf(opts, out) {
  const { audit: a, responses, sectionComments, nonconformances,
    score, attachments, attachmentsByContext } = opts;
  const ctxMap = attachmentsByContext || {};

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,
    info: {
      Title: `Site Audit #${a.id} — ${a.project_site || 'Untitled'}`,
      Author: 'T&S Traffic Control',
      Subject: 'Traffic Control Site Safety Audit',
    },
  });
  doc.pipe(out);

  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ---- HELPER: ensure space before adding content, or add page ----
  function ensureSpace(needed) {
    const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
    if (remaining < needed) doc.addPage();
  }

  // ---- HELPER: draw a rounded rect background ----
  function roundedRect(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }

  // ---- HELPER: embed images from attachments array (only image types) ----
  function embedImages(items, label) {
    const images = (items || []).filter(att => (att.mime_type || '').startsWith('image/'));
    if (!images.length) return;
    ensureSpace(120);
    doc.fontSize(8).fillColor(GRAY).text(label, { continued: false });
    doc.moveDown(0.3);
    const thumbW = 120;
    const thumbH = 90;
    const gap = 8;
    let x = doc.page.margins.left;
    let rowY = doc.y;
    images.forEach(function (att) {
      const fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(a.id), att.filename);
      if (!fs.existsSync(fp)) return;
      if (x + thumbW > doc.page.width - doc.page.margins.right) {
        x = doc.page.margins.left;
        rowY += thumbH + gap + (att.caption ? 12 : 0);
      }
      if (rowY + thumbH + 20 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        x = doc.page.margins.left;
        rowY = doc.y;
      }
      try {
        doc.image(fp, x, rowY, { fit: [thumbW, thumbH], align: 'center', valign: 'center' });
        if (att.caption) {
          doc.fontSize(6).fillColor(GRAY).text(att.caption, x, rowY + thumbH + 2, { width: thumbW, align: 'center' });
        }
      } catch (e) {
        // Skip images that can't be embedded (corrupt, unsupported format)
      }
      x += thumbW + gap;
    });
    doc.y = rowY + thumbH + (images.some(i => i.caption) ? 16 : 8);
    doc.x = doc.page.margins.left;
  }

  // ============================================================
  // PAGE 1: HEADER + SCORE + DETAILS
  // ============================================================

  // Logo + title header
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, doc.page.margins.left, doc.page.margins.top, { height: 50 });
  }
  doc.fontSize(18).fillColor(BRAND_DARK).text('Site Safety Audit Report', 170, doc.page.margins.top + 5, { width: pageW - 130 });
  doc.fontSize(9).fillColor(GRAY).text('T&S Traffic Control — Traffic Control Site Safety Audit', 170, doc.page.margins.top + 28);
  doc.fontSize(9).fillColor(GRAY).text(`Audit #${a.id} · ${fmtDate(a.audit_datetime || a.created_at)}`, 170, doc.page.margins.top + 40);

  // Horizontal rule
  doc.y = doc.page.margins.top + 60;
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(BRAND).lineWidth(2).stroke();
  doc.y += 15;

  // Score card
  const scoreBoxX = doc.page.margins.left;
  const scoreBoxY = doc.y;
  const scoreBoxW = 160;
  const scoreBoxH = 80;
  roundedRect(scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 6, BRAND_DARK);
  doc.fontSize(8).fillColor(WHITE).text('OVERALL SCORE', scoreBoxX + 12, scoreBoxY + 10, { width: scoreBoxW - 24 });
  doc.fontSize(32).fillColor(WHITE).text(`${score.percent}%`, scoreBoxX + 12, scoreBoxY + 22, { width: scoreBoxW - 24 });
  doc.fontSize(8).fillColor(WHITE).text(`${score.total} / ${score.max} items passed`, scoreBoxX + 12, scoreBoxY + 58, { width: scoreBoxW - 24 });

  // Finding badge
  const findX = scoreBoxX + scoreBoxW + 15;
  const findY = scoreBoxY;
  const findW = pageW - scoreBoxW - 15;
  roundedRect(findX, findY, findW, 35, 4, findingColor(a.overall_finding));
  doc.fontSize(8).fillColor(WHITE).text('FINDING', findX + 10, findY + 6);
  doc.fontSize(14).fillColor(WHITE).text(findingLabel(a.overall_finding), findX + 10, findY + 17, { width: findW - 20 });

  // Scoring groups
  const groupStartY = findY + 42;
  const groupColW = findW / 2;
  score.groups.forEach(function (g, i) {
    const gx = findX + (i % 2) * groupColW;
    const gy = groupStartY + Math.floor(i / 2) * 14;
    doc.fontSize(7).fillColor(GRAY).text(g.label, gx + 2, gy, { width: groupColW - 40, continued: false });
    doc.fontSize(7).fillColor('#111827').text(`${g.score}/${g.max} (${g.percent}%)`, gx + groupColW - 55, gy, { width: 53, align: 'right' });
  });

  doc.y = scoreBoxY + scoreBoxH + 20;

  // Audit details table
  const detailFields = [
    ['Client', a.client],
    ['Project / Site', a.project_site],
    ['Location', a.location],
    ['Job #', a.job_number || '—'],
    ['TGS / TCP Ref', a.tgs_ref],
    ['Shift', (a.shift || '').charAt(0).toUpperCase() + (a.shift || '').slice(1)],
    ['Weather', a.weather],
    ['Auditor', a.auditor_name || a.created_by_name],
    ['Supervisor / STMS', a.supervisor_name],
    ['Date / Time', fmtDate(a.audit_datetime || a.created_at)],
  ];
  const colW = pageW / 2;
  detailFields.forEach(function (f, i) {
    const dx = doc.page.margins.left + (i % 2) * colW;
    const dy = doc.y + Math.floor(i / 2) * 16;
    doc.fontSize(7).fillColor(GRAY).text(f[0].toUpperCase(), dx, dy);
    doc.fontSize(9).fillColor('#111827').text(f[1] || '—', dx, dy + 8, { width: colW - 10 });
  });
  doc.y += Math.ceil(detailFields.length / 2) * 16 + 10;

  // Divider
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
  doc.y += 10;

  // ---- Site overview evidence ----
  embedImages(ctxMap['overview'], 'SITE OVERVIEW EVIDENCE');

  // ============================================================
  // CHECKLIST SECTIONS
  // ============================================================
  AUDIT_SECTIONS.forEach(function (section) {
    ensureSpace(60);
    // Section header bar
    const barY = doc.y;
    roundedRect(doc.page.margins.left, barY, pageW, 22, 4, BRAND_DARK);
    doc.fontSize(10).fillColor(WHITE).text(`${section.key}. ${section.title}`, doc.page.margins.left + 8, barY + 5, { width: pageW - 60 });

    // Per-section score
    let secYes = 0, secMax = 0;
    section.items.forEach(function (_, idx) {
      const key = section.key + '.' + (idx + 1);
      const st = normaliseState(responses[key]);
      if (st === 'yes') { secYes++; secMax++; }
      else if (st === 'no') { secMax++; }
    });
    doc.fontSize(8).fillColor(WHITE).text(`${secYes}/${secMax}`, doc.page.margins.left + pageW - 50, barY + 7, { width: 42, align: 'right' });
    doc.y = barY + 28;

    // Items
    section.items.forEach(function (item, idx) {
      const key = section.key + '.' + (idx + 1);
      const r = responses[key] || {};
      const st = normaliseState(r);
      ensureSpace(22);

      const iy = doc.y;
      // Alternating bg
      if (idx % 2 === 0) {
        doc.save().rect(doc.page.margins.left, iy - 2, pageW, 16).fill(GRAY_LIGHT).restore();
      }

      // Badge
      let badge, badgeColor;
      if (st === 'yes') { badge = 'YES'; badgeColor = GREEN; }
      else if (st === 'no') { badge = 'NO'; badgeColor = RED; }
      else if (st === 'na') { badge = 'N/A'; badgeColor = GRAY; }
      else { badge = '—'; badgeColor = '#D1D5DB'; }

      roundedRect(doc.page.margins.left + 2, iy - 1, 28, 14, 3, badgeColor);
      doc.fontSize(7).fillColor(WHITE).text(badge, doc.page.margins.left + 4, iy + 1, { width: 24, align: 'center' });

      // Item text
      doc.fontSize(8).fillColor('#374151').text(`${key}  ${item}`, doc.page.margins.left + 35, iy, { width: pageW - 40 });
      doc.y = Math.max(doc.y, iy + 14);

      // Notes
      if (r.notes) {
        doc.fontSize(7).fillColor(GRAY).text(`  → ${r.notes}`, doc.page.margins.left + 35, doc.y, { width: pageW - 40 });
        doc.y += 2;
      }
    });

    // Section comments
    if (sectionComments[section.key]) {
      ensureSpace(25);
      doc.fontSize(7).fillColor(GRAY).text('COMMENTS:', doc.page.margins.left + 4, doc.y + 2);
      doc.fontSize(8).fillColor('#374151').text(sectionComments[section.key], doc.page.margins.left + 55, doc.y + 2, { width: pageW - 60 });
      doc.y += 6;
    }

    // Per-section evidence images
    embedImages(ctxMap['section_' + section.key], `SECTION ${section.key} EVIDENCE`);

    doc.y += 6;
  });

  // ============================================================
  // NON-CONFORMANCE REGISTER
  // ============================================================
  if (nonconformances && nonconformances.length) {
    ensureSpace(60);
    roundedRect(doc.page.margins.left, doc.y, pageW, 22, 4, RED);
    doc.fontSize(10).fillColor(WHITE).text('Non-Conformance Register', doc.page.margins.left + 8, doc.y + 5);
    doc.y += 28;

    // Table header
    const ncCols = [30, 0, 50, 0, 65, 55, 40]; // # , Issue, Risk, Action, Responsible, Due, Closed
    const issueFlex = Math.floor((pageW - 30 - 50 - 65 - 55 - 40) / 2);
    ncCols[1] = issueFlex;
    ncCols[3] = issueFlex;
    const ncHeaders = ['#', 'Issue', 'Risk', 'Action Required', 'Responsible', 'Due', 'Closed'];
    let cx = doc.page.margins.left;
    ncHeaders.forEach(function (h, i) {
      doc.fontSize(7).fillColor(GRAY).text(h.toUpperCase(), cx, doc.y, { width: ncCols[i] });
      cx += ncCols[i];
    });
    doc.y += 14;

    nonconformances.forEach(function (nc, i) {
      ensureSpace(25);
      const ry = doc.y;
      if (i % 2 === 0) {
        doc.save().rect(doc.page.margins.left, ry - 2, pageW, 14).fill(GRAY_LIGHT).restore();
      }
      cx = doc.page.margins.left;
      const vals = [String(i + 1), nc.issue, nc.risk || '—', nc.action || '—', nc.responsible || '—', nc.due_date || '—', nc.closed ? '✓' : '—'];
      vals.forEach(function (v, vi) {
        doc.fontSize(7).fillColor('#374151').text(v, cx, ry, { width: ncCols[vi] });
        cx += ncCols[vi];
      });
      doc.y = ry + 14;

      // Per-NC evidence
      embedImages(ctxMap['nc_' + (i + 1)], `NC #${i + 1} EVIDENCE`);
    });
    doc.y += 10;
  }

  // ============================================================
  // SIGNATURES
  // ============================================================
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    ensureSpace(80);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#E5E7EB').lineWidth(0.5).stroke();
    doc.y += 12;
    doc.fontSize(10).fillColor(BRAND_DARK).text('Sign-off', doc.page.margins.left, doc.y);
    doc.y += 16;

    const sigColW = pageW / 2;
    const sigY = doc.y;
    if (a.auditor_signature_text) {
      roundedRect(doc.page.margins.left, sigY, sigColW - 10, 50, 4, GRAY_LIGHT);
      doc.fontSize(7).fillColor(GRAY).text('AUDITOR', doc.page.margins.left + 8, sigY + 6);
      doc.fontSize(16).fillColor('#111827').text(a.auditor_signature_text, doc.page.margins.left + 8, sigY + 18, { width: sigColW - 26 });
      if (a.auditor_signed_at) {
        doc.fontSize(6).fillColor(GREEN).text(`Signed ${fmtDate(a.auditor_signed_at)}`, doc.page.margins.left + 8, sigY + 38);
      }
    }
    if (a.supervisor_signature_text) {
      const sx = doc.page.margins.left + sigColW;
      roundedRect(sx, sigY, sigColW - 10, 50, 4, GRAY_LIGHT);
      doc.fontSize(7).fillColor(GRAY).text('SUPERVISOR / STMS', sx + 8, sigY + 6);
      doc.fontSize(16).fillColor('#111827').text(a.supervisor_signature_text, sx + 8, sigY + 18, { width: sigColW - 26 });
      if (a.supervisor_signed_at) {
        doc.fontSize(6).fillColor(GREEN).text(`Signed ${fmtDate(a.supervisor_signed_at)}`, sx + 8, sigY + 38);
      }
    }
    doc.y = sigY + 58;
  }

  // Annotated TGS
  embedImages(ctxMap['annotated_tgs'], 'ANNOTATED TGS / CLOSE-OUT SKETCH');

  // ============================================================
  // FOOTER: page numbers
  // ============================================================
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor(GRAY).text(
      `T&S Traffic Control — Site Audit #${a.id} — Page ${i + 1} of ${pages.count}`,
      doc.page.margins.left,
      doc.page.height - 35,
      { width: pageW, align: 'center' }
    );
  }

  doc.end();
  return doc;
}

module.exports = { generateAuditPdf };
