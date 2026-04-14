/**
 * Audit PDF export v5 — professional branded T&S Traffic Control report.
 *
 * Design: Clean cover page, structured body, proper typography,
 * no blank pages, professional color scheme.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, normaliseState } = require('../lib/auditQuestions');

/* ── Brand palette ── */
const BRAND     = '#1D6AE5';
const BRAND_BG  = '#EBF2FF';   // light brand tint
const GREEN     = '#059669';
const GREEN_BG  = '#ECFDF5';
const RED       = '#DC2626';
const RED_BG    = '#FEF2F2';
const AMBER     = '#D97706';
const AMBER_BG  = '#FFFBEB';
const GRAY      = '#6B7280';
const GRAY_DARK = '#1F2937';
const GRAY_MED  = '#4B5563';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG   = '#F9FAFB';
const WHITE     = '#FFFFFF';
const BLACK     = '#111827';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 50, MR = 50, MT = 50, MB = 60;

/* ── Helpers ── */
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return String(d); }
}
function fmtDateShort(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', year: 'numeric' }); }
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
function findingBg(f) {
  if (f === 'pass') return GREEN_BG;
  if (f === 'fail') return RED_BG;
  return AMBER_BG;
}
function ucFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; }

/* ════════════════════════════════════════════════════════ */

function generateAuditPdf(opts, out) {
  const { audit: a, responses, sectionComments, nonconformances,
    score, attachmentsByContext } = opts;
  const ctxMap = attachmentsByContext || {};

  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: MT, bottom: MB, left: ML, right: MR },
    info: {
      Title: 'Site Audit #' + a.id + ' — ' + (a.project_site || 'Untitled'),
      Author: 'T&S Traffic Control',
    },
  });
  doc.pipe(out);

  const pw = doc.page.width - ML - MR;   // usable width
  const ph = doc.page.height;
  const pageBot = ph - MB;

  /* ── Drawing primitives ── */
  function curY() { return doc.y; }
  function setY(y) { doc.y = y; doc.x = ML; }
  function gap(n) { doc.y += n; }
  function need(h) { if (doc.y + h > pageBot) { doc.addPage(); } }

  function rect(x, y, w, h, fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  function roundRect(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }
  function line(x1, y1, x2, y2, color, width) {
    doc.save().moveTo(x1, y1).lineTo(x2, y2).strokeColor(color || GRAY_LINE).lineWidth(width || 0.5).stroke().restore();
  }

  /* Text — ALWAYS lineBreak:false unless explicitly multi-line to prevent blank pages */
  function txt(str, x, y, opts2) {
    doc.text(str || '', x, y, Object.assign({ lineBreak: false }, opts2 || {}));
  }

  function font(name, size, color) {
    doc.font(name || 'Helvetica').fontSize(size || 9).fillColor(color || BLACK);
  }

  /* Measure text height for multi-line content */
  function measureText(str, width, size) {
    doc.fontSize(size || 7);
    return doc.heightOfString(str || '', { width: width });
  }

  /* ═══════════════════════════════════════════════════════════
     PAGE 1: COVER / SUMMARY
     ═══════════════════════════════════════════════════════════ */

  // Top brand bar
  rect(0, 0, doc.page.width, 4, BRAND);

  // Logo
  let logoW = 0;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: 42 }); logoW = 120; } catch (e) {}
  }

  // Title block right of logo
  font('Helvetica-Bold', 18, BRAND);
  txt('Site Safety Audit', ML + logoW + 12, MT + 4, { width: pw - logoW - 12 });
  font('Helvetica', 9, GRAY);
  txt('T&S Traffic Control  ·  Audit #' + a.id, ML + logoW + 12, MT + 26, { width: pw - logoW - 12 });

  setY(MT + 52);
  line(ML, curY(), ML + pw, curY(), BRAND, 2);
  gap(16);

  // ── Overall Score Card ──
  const scoreCardY = curY();
  const scoreCardH = 70;
  roundRect(ML, scoreCardY, pw, scoreCardH, 6, GRAY_BG);

  // Score circle area (left)
  const circleX = ML + 45;
  const circleY = scoreCardY + 35;
  const circleR = 26;
  // Outer ring
  doc.save().circle(circleX, circleY, circleR).lineWidth(4).strokeColor(BRAND).stroke().restore();
  // Score text centered
  font('Helvetica-Bold', 22, BRAND);
  txt(score.percent + '%', circleX - 20, circleY - 11, { width: 40, align: 'center' });
  font('Helvetica', 7, GRAY);
  txt(score.total + '/' + score.max, circleX - 15, circleY + 10, { width: 30, align: 'center' });

  // Overall finding badge (right of circle)
  const badgeX = ML + 100;
  const badgeY = scoreCardY + 12;
  const badgeW = 150;
  roundRect(badgeX, badgeY, badgeW, 22, 4, findingColor(a.overall_finding));
  font('Helvetica-Bold', 10, WHITE);
  txt(findingLabel(a.overall_finding), badgeX + 10, badgeY + 6, { width: badgeW - 20 });

  // Area scores right side (3 cols)
  const areaX = badgeX;
  const areaY = badgeY + 28;
  const aColW = (pw - 100 + ML - areaX) > 0 ? Math.floor((ML + pw - areaX) / 3) : 100;
  score.groups.forEach(function (g, i) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const ax = areaX + col * aColW;
    const ay = areaY + row * 11;
    font('Helvetica', 6, GRAY);
    txt(g.label, ax, ay, { width: aColW - 35 });
    font('Helvetica-Bold', 6.5, g.percent >= 80 ? GREEN : g.percent >= 50 ? AMBER : RED);
    txt(g.score + '/' + g.max + ' (' + g.percent + '%)', ax + aColW - 50, ay, { width: 48, align: 'right' });
  });

  setY(scoreCardY + scoreCardH + 14);

  // ── Audit Details Table ──
  const details = [
    ['Project / Site',  a.project_site || '—'],
    ['Client',          a.client || '—'],
    ['Date',            fmtDate(a.audit_datetime || a.created_at)],
    ['Job Number',      a.job_number || '—'],
    ['Location',        a.location || '—'],
    ['Shift',           ucFirst(a.shift)],
    ['TGS / TCP Ref',   a.tgs_ref || '—'],
    ['Weather',         a.weather || '—'],
    ['Auditor',         a.auditor_name || a.created_by_name || '—'],
    ['Supervisor',      a.supervisor_name || '—'],
    ['Status',          (a.status || 'draft').replace(/_/g, ' ').toUpperCase()],
  ];
  const labelColW = 90;
  const valColW = pw / 2 - labelColW;
  const halfW = pw / 2;
  const detY = curY();
  details.forEach(function (d, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var dx = ML + col * halfW;
    var dy = detY + row * 16;
    // Alternating row background (spans full width on even indices)
    if (col === 0 && row % 2 === 0) {
      rect(ML, dy - 2, pw, 16, GRAY_BG);
    }
    font('Helvetica', 7, GRAY);
    txt(d[0], dx + 4, dy + 1, { width: labelColW - 8 });
    font('Helvetica-Bold', 7.5, GRAY_DARK);
    txt(d[1], dx + labelColW, dy + 1, { width: valColW - 4 });
  });
  setY(detY + Math.ceil(details.length / 2) * 16 + 4);

  // Follow-up notice
  if (a.follow_up_required) {
    need(22);
    var fuY = curY();
    roundRect(ML, fuY, pw, 18, 3, AMBER_BG);
    font('Helvetica-Bold', 7, AMBER);
    txt('⚠  FOLLOW-UP REQUIRED: ' + (a.follow_up_date ? fmtDateShort(a.follow_up_date) : 'TBC'), ML + 8, fuY + 5, { width: pw - 16 });
    setY(fuY + 22);
  }

  gap(4);

  // ── Site Overview Evidence ──
  embedImages(doc, a, ctxMap['overview'], 'Site Overview Photos', pw, pageBot, ML, MT);

  /* ═══════════════════════════════════════════════════════════
     CHECKLIST SECTIONS
     ═══════════════════════════════════════════════════════════ */
  AUDIT_SECTIONS.forEach(function (section) {
    need(40);

    // Section header bar
    var hY = curY();
    roundRect(ML, hY, pw, 20, 4, BRAND);
    font('Helvetica-Bold', 9, WHITE);
    txt(section.key + '.  ' + section.title, ML + 8, hY + 5, { width: pw - 60 });
    // Section score
    var sYes = 0, sMax = 0;
    section.items.forEach(function (_, idx) {
      var st = normaliseState(responses[section.key + '.' + (idx + 1)]);
      if (st === 'yes') { sYes++; sMax++; } else if (st === 'no') { sMax++; }
    });
    var sPct = sMax ? Math.round(sYes / sMax * 100) : 0;
    font('Helvetica-Bold', 8, WHITE);
    txt(sYes + '/' + sMax + '  (' + sPct + '%)', ML + pw - 80, hY + 6, { width: 72, align: 'right' });
    setY(hY + 24);

    // Column headers
    var colHY = curY();
    rect(ML, colHY, pw, 12, GRAY_BG);
    font('Helvetica-Bold', 6, GRAY);
    txt('STATUS', ML + 4, colHY + 3, { width: 35 });
    txt('REF', ML + 38, colHY + 3, { width: 22 });
    txt('ITEM', ML + 62, colHY + 3, { width: pw - 66 });
    setY(colHY + 13);

    // Items
    section.items.forEach(function (item, idx) {
      var key = section.key + '.' + (idx + 1);
      var r = responses[key] || {};
      var st = normaliseState(r);
      var rowH = r.notes ? 20 : 12;
      need(rowH);

      var iy = curY();
      // Zebra stripe
      if (idx % 2 === 0) rect(ML, iy, pw, rowH, GRAY_BG);
      // Subtle bottom line
      line(ML, iy + rowH, ML + pw, iy + rowH, '#F3F4F6', 0.3);

      // Status badge
      var badge, bc, bgc;
      if (st === 'yes')      { badge = 'YES'; bc = WHITE; bgc = GREEN; }
      else if (st === 'no')  { badge = 'NO';  bc = WHITE; bgc = RED; }
      else if (st === 'na')  { badge = 'N/A'; bc = WHITE; bgc = GRAY; }
      else                   { badge = '—';   bc = GRAY;  bgc = '#E5E7EB'; }
      roundRect(ML + 4, iy + 2, 28, 9, 2, bgc);
      font('Helvetica-Bold', 5.5, bc);
      txt(badge, ML + 5, iy + 3.5, { width: 26, align: 'center' });

      // Ref number
      font('Helvetica', 6.5, GRAY);
      txt(key, ML + 38, iy + 3, { width: 22 });

      // Item text
      font('Helvetica', 7, GRAY_DARK);
      txt(item, ML + 62, iy + 3, { width: pw - 66, height: 9, ellipsis: true });

      // Notes (if any)
      if (r.notes) {
        font('Helvetica-Oblique', 6, GRAY_MED);
        txt('↳ ' + r.notes, ML + 62, iy + 12, { width: pw - 66, height: 7, ellipsis: true });
      }

      setY(iy + rowH);
    });

    // Section comments
    if (sectionComments[section.key]) {
      var cmtText = sectionComments[section.key];
      var cmtH = measureText(cmtText, pw - 24, 7);
      var boxH = Math.min(cmtH + 16, 80); // cap height
      need(boxH + 4);
      gap(3);
      var cy = curY();
      roundRect(ML, cy, pw, boxH, 4, BRAND_BG);
      // Left accent bar
      roundRect(ML, cy, 3, boxH, 1, BRAND);
      font('Helvetica-Bold', 6, BRAND);
      txt('COMMENTS', ML + 10, cy + 4, { width: 60 });
      // Multi-line comment text — use lineBreak:true but constrain height
      doc.font('Helvetica').fontSize(7).fillColor(GRAY_DARK);
      doc.text(cmtText, ML + 10, cy + 13, { width: pw - 24, height: boxH - 16, lineBreak: true, ellipsis: true });
      setY(cy + boxH + 2);
    }

    // Section evidence images
    embedImages(doc, a, ctxMap['section_' + section.key], null, pw, pageBot, ML, MT);
    gap(6);
  });

  /* ═══════════════════════════════════════════════════════════
     NON-CONFORMANCE REGISTER
     ═══════════════════════════════════════════════════════════ */
  if (nonconformances && nonconformances.length) {
    need(50);
    gap(4);
    var ncHeaderY = curY();
    roundRect(ML, ncHeaderY, pw, 20, 4, RED);
    font('Helvetica-Bold', 9, WHITE);
    txt('Non-Conformance Register  (' + nonconformances.length + ')', ML + 8, ncHeaderY + 5, { width: pw - 16 });
    setY(ncHeaderY + 24);

    // Table header
    var thY = curY();
    rect(ML, thY, pw, 13, RED_BG);
    var ncCols = { n: 18, issue: 0, risk: 35, action: 0, resp: 50, due: 45, done: 28 };
    var ncFlex = Math.floor((pw - ncCols.n - ncCols.risk - ncCols.resp - ncCols.due - ncCols.done) / 2);
    ncCols.issue = ncFlex;
    ncCols.action = ncFlex;
    var headers = [
      { label: '#', w: ncCols.n },
      { label: 'Issue', w: ncCols.issue },
      { label: 'Risk', w: ncCols.risk },
      { label: 'Action Required', w: ncCols.action },
      { label: 'Responsible', w: ncCols.resp },
      { label: 'Due', w: ncCols.due },
      { label: 'Closed', w: ncCols.done },
    ];
    var hx = ML;
    headers.forEach(function (h) {
      font('Helvetica-Bold', 5.5, RED);
      txt(h.label, hx + 2, thY + 4, { width: h.w - 4 });
      hx += h.w;
    });
    setY(thY + 14);

    // NC rows
    nonconformances.forEach(function (nc, i) {
      need(14);
      var ry = curY();
      if (i % 2 === 0) rect(ML, ry, pw, 12, GRAY_BG);
      var cx = ML;
      var vals = [
        { v: String(i + 1), w: ncCols.n },
        { v: nc.issue || '—', w: ncCols.issue },
        { v: nc.risk || '—', w: ncCols.risk },
        { v: nc.action || '—', w: ncCols.action },
        { v: nc.responsible || '—', w: ncCols.resp },
        { v: nc.due_date || '—', w: ncCols.due },
        { v: nc.closed ? '✓ Yes' : '—', w: ncCols.done },
      ];
      vals.forEach(function (cell) {
        font('Helvetica', 6, GRAY_DARK);
        txt(cell.v, cx + 2, ry + 3, { width: cell.w - 4, height: 9, ellipsis: true });
        cx += cell.w;
      });
      setY(ry + 12);

      // NC evidence images
      embedImages(doc, a, ctxMap['nc_' + (i + 1)], null, pw, pageBot, ML, MT);
    });
    gap(6);
  }

  /* ═══════════════════════════════════════════════════════════
     SIGNATURES
     ═══════════════════════════════════════════════════════════ */
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    need(80);
    gap(6);
    line(ML, curY(), ML + pw, curY(), BRAND, 1);
    gap(8);
    font('Helvetica-Bold', 10, BRAND);
    txt('Sign-off', ML, curY(), { width: pw });
    gap(16);

    var sigY = curY();
    var sigW = (pw - 16) / 2;

    function drawSigBox(x, label, name, signedAt) {
      // Box with brand top border
      roundRect(x, sigY, sigW, 58, 5, WHITE);
      rect(x, sigY, sigW, 3, BRAND);
      // Subtle border
      doc.save().roundedRect(x, sigY, sigW, 58, 5).strokeColor(GRAY_LINE).lineWidth(0.5).stroke().restore();
      // Label
      font('Helvetica-Bold', 6, GRAY);
      txt(label, x + 10, sigY + 8, { width: sigW - 20 });
      // Signature name — large italic cursive
      doc.font('Helvetica-Oblique').fontSize(16).fillColor(GRAY_DARK);
      txt(name, x + 10, sigY + 20, { width: sigW - 20 });
      doc.font('Helvetica');
      // Signed date
      if (signedAt) {
        font('Helvetica', 6, GREEN);
        txt('✓ Signed  ·  ' + fmtDate(signedAt), x + 10, sigY + 43, { width: sigW - 20 });
      }
    }

    if (a.auditor_signature_text) {
      drawSigBox(ML, 'AUDITOR', a.auditor_signature_text, a.auditor_signed_at);
    }
    if (a.supervisor_signature_text) {
      drawSigBox(ML + sigW + 16, 'SUPERVISOR / STMS', a.supervisor_signature_text, a.supervisor_signed_at);
    }
    setY(sigY + 64);
  }

  // ── Annotated TGS ──
  embedImages(doc, a, ctxMap['annotated_tgs'], 'Annotated TGS / Close-out Sketch', pw, pageBot, ML, MT);

  /* ═══════════════════════════════════════════════════════════
     FOOTER — Created by + Internal Sign-off
     ═══════════════════════════════════════════════════════════ */
  gap(10);
  need(50);
  line(ML, curY(), ML + pw, curY(), GRAY_LINE, 0.5);
  gap(6);

  // Created by
  font('Helvetica', 6.5, GRAY);
  txt('Created by  ' + (a.created_by_name || '—') + '  ·  ' + fmtDate(a.created_at), ML, curY(), { width: pw });
  gap(10);

  // Internal sign-off
  if (a.signed_off_by_name) {
    var soY = curY();
    var soH = 32;
    roundRect(ML, soY, pw, soH, 5, GREEN_BG);
    // Left green accent
    roundRect(ML, soY, 4, soH, 2, GREEN);
    // Check icon area
    roundRect(ML + 14, soY + 8, 16, 16, 8, GREEN);
    font('Helvetica-Bold', 10, WHITE);
    txt('✓', ML + 17, soY + 11, { width: 12, align: 'center' });
    // Text
    font('Helvetica-Bold', 7, GREEN);
    txt('INTERNALLY SIGNED OFF', ML + 38, soY + 8, { width: pw - 46 });
    font('Helvetica', 7.5, GRAY_DARK);
    txt(a.signed_off_by_name + '  ·  ' + fmtDate(a.signed_off_at), ML + 38, soY + 19, { width: pw - 46 });
    setY(soY + soH + 4);
  }

  /* ═══════════════════════════════════════════════════════════
     PAGE NUMBERS + FOOTER BAR
     ═══════════════════════════════════════════════════════════ */
  var range = doc.bufferedPageRange();
  var totalPages = range.count;
  for (var p = range.start; p < range.start + totalPages; p++) {
    doc.switchToPage(p);
    // Bottom brand line
    line(ML, ph - MB + 10, ML + pw, ph - MB + 10, GRAY_LINE, 0.3);
    // Footer text
    font('Helvetica', 5.5, GRAY);
    txt('T&S Traffic Control  ·  Site Audit #' + a.id + '  ·  Confidential',
      ML, ph - MB + 14, { width: pw - 50 });
    font('Helvetica', 5.5, GRAY);
    txt('Page ' + (p + 1) + ' of ' + totalPages,
      ML + pw - 50, ph - MB + 14, { width: 50, align: 'right' });
    // Top brand bar on every page (except first which already has it)
    if (p > range.start) {
      rect(0, 0, doc.page.width, 3, BRAND);
    }
  }

  doc.end();
}


/* ════════════════════════════════════════════════════════
   Image grid — embeds photos in rows, handles page breaks
   ════════════════════════════════════════════════════════ */
function embedImages(doc, audit, items, label, pw, pageBot, ml, mt) {
  if (!items || !items.length) return;

  var images = [];
  items.forEach(function (att) {
    if (!(att.mime_type || '').startsWith('image/')) return;
    var fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    if (fs.existsSync(fp)) images.push({ att: att, fp: fp });
  });
  if (!images.length) return;

  // Section label
  if (label) {
    if (doc.y + 18 > pageBot) doc.addPage();
    doc.y += 4;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY);
    doc.text(label, ml, doc.y, { lineBreak: false });
    doc.font('Helvetica');
    doc.y += 10;
  }

  var tw = 90, th = 68, gx = 6, gy = 6;
  var cols = Math.floor((pw + gx) / (tw + gx));
  if (cols < 1) cols = 1;
  var col = 0, rowY = doc.y;

  images.forEach(function (img) {
    if (col >= cols) { col = 0; rowY += th + gy; }
    if (col === 0 && rowY + th > pageBot) { doc.addPage(); rowY = doc.y; }
    var ix = ml + col * (tw + gx);
    // Image border/shadow
    doc.save().roundedRect(ix, rowY, tw, th, 3).strokeColor('#E5E7EB').lineWidth(0.5).stroke().restore();
    try {
      doc.image(img.fp, ix + 1, rowY + 1, { fit: [tw - 2, th - 2], align: 'center', valign: 'center' });
    } catch (e) { /* skip corrupt image */ }
    // Caption
    if (img.att.caption) {
      doc.font('Helvetica').fontSize(5).fillColor(GRAY);
      doc.text(img.att.caption, ix, rowY + th + 1, { width: tw, lineBreak: false, height: 7, ellipsis: true });
    }
    col++;
  });
  doc.y = rowY + th + (images[images.length - 1] && images[images.length - 1].att.caption ? 10 : gy);
  doc.x = ml;
}


module.exports = { generateAuditPdf };
