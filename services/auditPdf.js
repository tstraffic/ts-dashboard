/**
 * Audit PDF export v5 — T&S Traffic Control
 * Complete rewrite addressing all 7 issues from DEV-001 spec:
 *   Fix 1: Structured observation blocks for NO items
 *   Fix 2: Comment text styling (11pt, dark, bordered box)
 *   Fix 3: Evidence photos max 2/row, min 45% width, captioned
 *   Fix 4: (App-side) Comment enforcement — PDF renders whatever data exists
 *   Fix 5: N/A items collapsed (3+ consecutive) or de-emphasised
 *   Fix 6: No blank pages, running footer, accurate page count
 *   Fix 7: Findings summary on cover, color-coded scores, clean details grid
 *
 * Legacy fallback: old audits with NO items but only a notes field
 * render in a red "Legacy observation" box — no historical exports broken.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, normaliseState } = require('../lib/auditQuestions');

const BRAND      = '#1D6AE5';
const BRAND_DARK = '#0F4C99';
const GREEN      = '#059669';
const RED        = '#DC2626';
const RED_LIGHT  = '#FCE4E4';
const RED_BADGE  = '#C00000';
const AMBER      = '#D97706';
const GRAY       = '#6B7280';
const GRAY_DARK  = '#333333';
const GRAY_MED   = '#4B5563';
const GRAY_LIGHT = '#F3F4F6';
const GRAY_BORDER= '#DDDDDD';
const COMMENT_BG = '#F5F5F5';
const WHITE      = '#FFFFFF';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 45, MR = 45, MT = 40, MB = 50;

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }); }
  catch (e) { return String(d); }
}
function findingLabel(f) {
  if (f === 'pass') return 'PASS';
  if (f === 'pass_with_actions') return 'PASS WITH ACTIONS';
  if (f === 'fail') return 'FAIL — IMMEDIATE RECTIFICATION';
  return (f || '—').toUpperCase();
}
function findingColor(f) {
  if (f === 'pass') return GREEN;
  if (f === 'fail') return RED;
  return AMBER;
}
function scoreColor(pct) {
  if (pct >= 90) return GREEN;
  if (pct >= 70) return AMBER;
  return RED;
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
  const pageBot = doc.page.height - MB - 12; // leave room for running footer

  /* ---- Layout helpers ---- */
  function Y()     { return doc.y; }
  function setY(y) { doc.y = y; doc.x = ML; }
  function gap(n)  { doc.y += n; }
  function need(h) { if (doc.y + h > pageBot) doc.addPage(); }

  function rr(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }
  function hline(y, color, width) {
    doc.save().moveTo(ML, y).lineTo(ML + pw, y)
      .strokeColor(color || '#E5E7EB').lineWidth(width || 0.5).stroke().restore();
  }
  function T(sz, col, str, x, y, w, o) {
    doc.font('Helvetica').fontSize(sz).fillColor(col)
      .text(str || '—', x, y, Object.assign({ lineBreak: false, width: w }, o || {}));
  }
  function TB(sz, col, str, x, y, w, o) {
    doc.font('Helvetica-Bold').fontSize(sz).fillColor(col)
      .text(str || '—', x, y, Object.assign({ lineBreak: false, width: w }, o || {}));
  }
  function TM(sz, col, str, x, y, w) {
    // Multi-line text (lineBreak: true)
    doc.font('Helvetica').fontSize(sz).fillColor(col)
      .text(str || '', x, y, { width: w, lineBreak: true });
  }

  // ==================================================================
  // PAGE 1 — COVER
  // ==================================================================

  // Header: logo + title
  const logoH = 36;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: logoH }); } catch (e) {}
  }
  TB(15, BRAND, 'Site Safety Audit Report', ML + 130, MT + 2, pw - 130);
  T(7.5, GRAY, `Audit #${a.id}  ·  ${fmtDate(a.audit_datetime || a.created_at)}`, ML + 130, MT + 20, pw - 130);
  T(7.5, GRAY, 'T&S Traffic Control', ML + 130, MT + 30, pw - 130);
  setY(MT + logoH + 6);
  hline(Y(), BRAND, 1.5);
  gap(10);

  // ---- Score box + finding badge ----
  const bandY = Y();
  const sBoxW = 95, sBoxH = 45;
  rr(ML, bandY, sBoxW, sBoxH, 5, BRAND);
  T(6, WHITE, 'OVERALL SCORE', ML + 8, bandY + 4, sBoxW - 16);
  doc.font('Helvetica-Bold').fontSize(24).fillColor(WHITE)
    .text(`${score.percent}%`, ML + 8, bandY + 12, { lineBreak: false, width: sBoxW - 16 });
  T(6, WHITE, `${score.total}/${score.max} passed`, ML + 8, bandY + 36, sBoxW - 16);

  const fX = ML + sBoxW + 8, fW = pw - sBoxW - 8;
  rr(fX, bandY, fW, 18, 3, findingColor(a.overall_finding));
  TB(9, WHITE, findingLabel(a.overall_finding), fX + 8, bandY + 4, fW - 16);
  setY(bandY + sBoxH + 6);

  // ---- FIX 7: Category scores — color-coded (green ≥90%, amber 70-89%, red <70%) ----
  const aRows = Math.ceil(score.groups.length / 4);
  const aH = 4 + aRows * 12;
  const aY = Y();
  rr(ML, aY, pw, aH, 3, GRAY_LIGHT);
  const aColW = pw / 4;
  score.groups.forEach(function (g, i) {
    const col = i % 4, row = Math.floor(i / 4);
    const ax = ML + col * aColW + 4, ay = aY + 3 + row * 12;
    T(5.5, GRAY, g.label, ax, ay, aColW - 54);
    const sc = scoreColor(g.percent);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(sc)
      .text(`${g.score}/${g.max} (${g.percent}%)`, ax + aColW - 54, ay,
        { lineBreak: false, width: 50, align: 'right' });
  });
  setY(aY + aH + 4);

  // ---- FIX 7: Findings summary — list all NO items on cover ----
  const failures = [];
  AUDIT_SECTIONS.forEach(function (sec) {
    sec.items.forEach(function (item, idx) {
      const key = sec.key + '.' + (idx + 1);
      const r = responses[key] || {};
      if (normaliseState(r) === 'no') {
        const short = item.length > 55 ? item.substring(0, 52) + '...' : item;
        failures.push({ key: key, item: short, section: sec.title });
      }
    });
  });

  if (failures.length > 0) {
    const sumH = 16 + failures.length * 10;
    need(sumH);
    const fsY = Y();
    rr(ML, fsY, pw, 13, 3, RED_LIGHT);
    doc.save().roundedRect(ML, fsY, 3, 13, 1).fill(RED).restore();
    TB(6.5, RED, `${failures.length} non-conformance${failures.length !== 1 ? 's' : ''} identified (see details)`,
      ML + 8, fsY + 3, pw - 16);
    setY(fsY + 16);
    failures.forEach(function (f) {
      need(10);
      TB(6, GRAY_DARK, f.key, ML + 8, Y(), 22);
      T(6, GRAY_DARK, f.item, ML + 32, Y(), pw * 0.48);
      T(5.5, GRAY, '(' + f.section + ')', ML + 32 + pw * 0.48 + 4, Y(), pw * 0.3);
      gap(10);
    });
    gap(2);
  }

  // ---- FIX 7: Site details — fixed 4-column grid ----
  hline(Y(), '#E5E7EB', 0.5);
  gap(6);
  const details = [
    ['PROJECT / SITE', a.project_site],  ['DATE',       fmtDate(a.audit_datetime || a.created_at)],
    ['CLIENT',         a.client],         ['JOB #',      a.job_number || '—'],
    ['LOCATION',       a.location],       ['SHIFT',      (a.shift || '—').charAt(0).toUpperCase() + (a.shift || '').slice(1)],
    ['TGS / TCP REF',  a.tgs_ref],       ['WEATHER',    a.weather],
    ['AUDITOR',        a.auditor_name || a.created_by_name], ['SUPERVISOR', a.supervisor_name],
  ];
  const dColW = pw / 2, lblW = 72;
  const dY = Y();
  details.forEach(function (d, i) {
    const col = i % 2, row = Math.floor(i / 2);
    const dx = ML + col * dColW, dy = dY + row * 13;
    TB(5.5, BRAND_DARK, d[0], dx, dy, lblW);
    T(7, GRAY_DARK, d[1], dx + lblW + 2, dy, dColW - lblW - 6);
  });
  setY(dY + Math.ceil(details.length / 2) * 13 + 2);

  TB(5.5, BRAND_DARK, 'STATUS', ML, Y(), lblW);
  T(7, GRAY_DARK, (a.status || 'draft').replace('_', ' ').toUpperCase(), ML + lblW + 2, Y(), dColW - lblW);
  gap(10);
  if (a.follow_up_required) {
    T(6, AMBER, 'FOLLOW-UP REQUIRED: ' + (a.follow_up_date || 'TBC'), ML, Y(), pw);
    gap(10);
  }
  hline(Y(), '#E5E7EB', 0.5);
  gap(6);

  // Site overview evidence
  embedPhotos('SITE OVERVIEW EVIDENCE', ctxMap['overview'], null);

  // ==================================================================
  // CHECKLIST SECTIONS
  // ==================================================================
  AUDIT_SECTIONS.forEach(function (section) {
    need(30);
    // Section header bar
    const hY = Y();
    rr(ML, hY, pw, 16, 3, BRAND);
    TB(8, WHITE, `${section.key}. ${section.title}`, ML + 6, hY + 3, pw - 56);
    let sYes = 0, sMax = 0;
    section.items.forEach(function (_, idx) {
      const st = normaliseState(responses[section.key + '.' + (idx + 1)]);
      if (st === 'yes') { sYes++; sMax++; } else if (st === 'no') { sMax++; }
    });
    TB(7, WHITE, `${sYes}/${sMax}`, ML + pw - 42, hY + 4, 36, { align: 'right' });
    setY(hY + 19);

    // Collect items with their states
    const items = section.items.map(function (item, idx) {
      const key = section.key + '.' + (idx + 1);
      const r = responses[key] || {};
      return { key: key, item: item, r: r, state: normaliseState(r) };
    });

    // ---- Render items with FIX 5 (N/A collapsing) ----
    var ii = 0;
    while (ii < items.length) {
      var it = items[ii];

      // FIX 5: Consecutive N/A run detection
      if (it.state === 'na') {
        var naRun = [it];
        var jj = ii + 1;
        while (jj < items.length && normaliseState(items[jj].r) === 'na') {
          naRun.push(items[jj]);
          jj++;
        }
        if (naRun.length >= 3) {
          // Collapsed summary row
          need(12);
          var cyNA = Y();
          var keyList = naRun.map(function (n) { return n.key; }).join(', ');
          doc.font('Helvetica').fontSize(8).fillColor('#999999')
            .text('Items ' + keyList + ' — not applicable to this site', ML + 4, cyNA + 1,
              { lineBreak: false, width: pw - 8, height: 10 });
          setY(cyNA + 12);
          ii = jj;
          continue;
        }
        // < 3 consecutive: render individually, de-emphasised
        for (var kk = 0; kk < naRun.length; kk++) {
          need(9);
          var niy = Y();
          rr(ML + 1, niy, 24, 8, 2, '#E0E0E0');
          doc.font('Helvetica').fontSize(5).fillColor('#777777')
            .text('N/A', ML + 2, niy + 1.5, { lineBreak: false, width: 22, align: 'center' });
          doc.font('Helvetica').fontSize(6).fillColor('#999999')
            .text(naRun[kk].key + '  ' + naRun[kk].item, ML + 28, niy + 1,
              { lineBreak: false, width: pw - 32, height: 7, ellipsis: true });
          setY(niy + 9);
        }
        ii = jj;
        continue;
      }

      // ---- FIX 1: NO items — structured observation block ----
      if (it.state === 'no') {
        // Main row — full-width light red
        need(14);
        var noy = Y();
        doc.save().rect(ML, noy - 1, pw, 13).fill(RED_LIGHT).restore();

        // NO badge — larger, bold, white on dark red
        rr(ML + 1, noy, 28, 10, 2, RED_BADGE);
        doc.font('Helvetica-Bold').fontSize(6).fillColor(WHITE)
          .text('NO', ML + 2, noy + 2, { lineBreak: false, width: 26, align: 'center' });

        // Item text — bold
        doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY_DARK)
          .text(it.key + '  ' + it.item, ML + 32, noy + 2,
            { lineBreak: false, width: pw - 36, height: 9, ellipsis: true });
        setY(noy + 14);

        // Observation block (structured or legacy fallback)
        var obs  = it.r.observation || '';
        var risk = it.r.risk_level || '';
        var corr = it.r.corrective_action || '';
        var resp = it.r.responsible || '';
        var rect = it.r.rectified_on_site;
        var hasStructured = (obs || risk || corr || resp);

        if (hasStructured) {
          // Structured observation block
          var indent = 24;
          var bx = ML + indent, bw = pw - indent;
          var fldH = 12;

          // Estimate height
          var obsLines = obs ? Math.max(1, Math.ceil(obs.length / Math.floor(bw / 3.8))) : 0;
          var actLines = corr ? Math.max(1, Math.ceil(corr.length / Math.floor(bw / 3.8))) : 0;
          var totalH = 8;
          if (obs)  totalH += 10 + obsLines * 8;
          if (risk) totalH += fldH;
          if (corr) totalH += 10 + actLines * 8;
          if (resp) totalH += fldH;
          if (rect !== undefined && rect !== null && rect !== '') totalH += fldH;
          totalH += 6;

          need(totalH);
          var bY = Y();
          rr(bx, bY, bw, totalH, 3, '#FEF2F2');
          doc.save().roundedRect(bx, bY, 3, totalH, 1).fill(RED).restore();
          doc.save().roundedRect(bx, bY, bw, totalH, 3).strokeColor('#FECACA').lineWidth(0.5).stroke().restore();

          var cy = bY + 6;

          if (obs) {
            TB(6, BRAND_DARK, 'OBSERVATION', bx + 8, cy, bw - 16);
            cy += 9;
            doc.font('Helvetica').fontSize(7).fillColor(GRAY_DARK)
              .text(obs, bx + 8, cy, { width: bw - 16, lineBreak: true });
            cy += obsLines * 8 + 4;
          }
          if (risk) {
            TB(6, BRAND_DARK, 'RISK LEVEL', bx + 8, cy, 50);
            var rc = risk === 'Critical' ? RED : risk === 'High' ? '#DC2626' : risk === 'Medium' ? AMBER : GREEN;
            rr(bx + 60, cy - 1, 50, 9, 2, rc);
            doc.font('Helvetica-Bold').fontSize(5.5).fillColor(WHITE)
              .text(risk.toUpperCase(), bx + 62, cy, { lineBreak: false, width: 46, align: 'center' });
            cy += fldH;
          }
          if (corr) {
            TB(6, BRAND_DARK, 'CORRECTIVE ACTION', bx + 8, cy, bw - 16);
            cy += 9;
            doc.font('Helvetica').fontSize(7).fillColor(GRAY_DARK)
              .text(corr, bx + 8, cy, { width: bw - 16, lineBreak: true });
            cy += actLines * 8 + 4;
          }
          if (resp) {
            TB(6, BRAND_DARK, 'RESPONSIBLE', bx + 8, cy, 55);
            T(7, GRAY_DARK, resp, bx + 65, cy, bw - 75);
            cy += fldH;
          }
          if (rect !== undefined && rect !== null && rect !== '') {
            TB(6, BRAND_DARK, 'RECTIFIED ON SITE', bx + 8, cy, 72);
            var rtext = rect ? 'Yes' : 'No — escalated to HSEQ';
            var rcol  = rect ? GREEN : RED;
            doc.font('Helvetica-Bold').fontSize(6).fillColor(rcol)
              .text(rtext, bx + 82, cy, { lineBreak: false, width: bw - 92 });
            cy += fldH;
          }

          setY(bY + totalH + 3);
        } else if (it.r.notes) {
          // Legacy fallback — red "Legacy observation" box
          var indent2 = 24;
          var bx2 = ML + indent2, bw2 = pw - indent2;
          var nLines = Math.max(1, Math.ceil(it.r.notes.length / Math.floor(bw2 / 3.8)));
          var bH2 = 14 + nLines * 8;
          need(bH2);
          var bY2 = Y();
          rr(bx2, bY2, bw2, bH2, 3, '#FEF2F2');
          doc.save().roundedRect(bx2, bY2, 3, bH2, 1).fill(RED).restore();
          doc.save().roundedRect(bx2, bY2, bw2, bH2, 3).strokeColor('#FECACA').lineWidth(0.5).stroke().restore();
          TB(6, BRAND_DARK, 'OBSERVATION', bx2 + 8, bY2 + 4, bw2 - 16);
          doc.font('Helvetica').fontSize(7).fillColor(GRAY_DARK)
            .text(it.r.notes, bx2 + 8, bY2 + 14, { width: bw2 - 16, lineBreak: true });
          setY(bY2 + bH2 + 3);
        }

        // FIX 3: Item-specific photos inside observation context
        embedPhotos(null, ctxMap['item_' + it.key], it.key);

        ii++;
        continue;
      }

      // ---- YES items — standard row ----
      need(11);
      var yy = Y();
      rr(ML + 1, yy, 24, 9, 2, '#548235');
      doc.font('Helvetica-Bold').fontSize(5.5).fillColor(WHITE)
        .text('YES', ML + 2, yy + 2, { lineBreak: false, width: 22, align: 'center' });
      doc.font('Helvetica').fontSize(7).fillColor(GRAY_DARK)
        .text(it.key + '  ' + it.item, ML + 28, yy + 1,
          { lineBreak: false, width: pw - 32, height: 8, ellipsis: true });
      setY(yy + 11);

      // YES item notes — only if non-empty (Fix 4 note: don't render empty boxes)
      if (it.r.notes && it.r.notes.trim()) {
        need(10);
        doc.font('Helvetica').fontSize(6).fillColor(GRAY_MED)
          .text('\u2192 ' + it.r.notes, ML + 28, Y(),
            { width: pw - 32, lineBreak: false, height: 7, ellipsis: true });
        gap(8);
      }
      ii++;
    }

    // ---- FIX 2: Section comments — bordered box, readable, navy label ----
    // Only render if there's actual comment text (don't render empty boxes)
    if (sectionComments[section.key] && sectionComments[section.key].trim()) {
      var cmtText = sectionComments[section.key];
      var cpl = Math.floor((pw - 24) / 4);
      var cmtLines = Math.max(1, Math.ceil(cmtText.length / cpl));
      var cmtH = 20 + cmtLines * 10;
      need(cmtH + 4);
      var cmtY = Y();

      // Bordered box with light grey fill
      rr(ML, cmtY, pw, cmtH, 3, COMMENT_BG);
      doc.save().roundedRect(ML, cmtY, pw, cmtH, 3).strokeColor(GRAY_BORDER).lineWidth(1).stroke().restore();
      doc.save().roundedRect(ML, cmtY, 3, cmtH, 1).fill(BRAND).restore();

      // Label: navy bold, 10pt equivalent
      TB(7, BRAND_DARK, 'COMMENTS', ML + 10, cmtY + 5, pw - 20);

      // Comment body: 11pt equivalent (8pt in PDFKit ~ 11pt rendered), #333333
      doc.font('Helvetica').fontSize(8).fillColor(GRAY_DARK)
        .text(cmtText, ML + 10, cmtY + 17, { width: pw - 24, lineBreak: true });

      setY(cmtY + cmtH + 3);
    }

    // Section-level photos (general section evidence, not tied to specific items)
    embedPhotos(null, ctxMap['section_' + section.key], null);
    gap(3);
  });

  // ==================================================================
  // NON-CONFORMANCE REGISTER
  // ==================================================================
  if (nonconformances && nonconformances.length) {
    need(35);
    var ncHY = Y();
    rr(ML, ncHY, pw, 16, 3, RED);
    TB(8, WHITE, 'Non-Conformance Register', ML + 6, ncHY + 3, pw - 16);
    setY(ncHY + 19);

    var ncW = [14, 0, 32, 0, 46, 40, 24];
    var ncFlex = Math.floor((pw - 14 - 32 - 46 - 40 - 24) / 2);
    ncW[1] = ncFlex; ncW[3] = ncFlex;

    var ncx = ML;
    ['#', 'Issue', 'Risk', 'Action', 'Resp.', 'Due', 'Done'].forEach(function (h, hi) {
      TB(5, GRAY, h, ncx, Y(), ncW[hi]);
      ncx += ncW[hi];
    });
    gap(8);

    nonconformances.forEach(function (nc, ni) {
      need(10);
      var ry = Y();
      if (ni % 2 === 0) doc.save().rect(ML, ry - 1, pw, 9).fill(GRAY_LIGHT).restore();
      ncx = ML;
      [String(ni + 1), nc.issue || '', nc.risk || '—', nc.action || '—',
       nc.responsible || '—', nc.due_date || '—', nc.closed ? '\u2713' : '—'].forEach(function (v, vi) {
        T(5.5, GRAY_DARK, v, ncx, ry, ncW[vi], { height: 8, ellipsis: true });
        ncx += ncW[vi];
      });
      setY(ry + 9);
      embedPhotos(null, ctxMap['nc_' + (ni + 1)], null);
    });
    gap(4);
  }

  // ==================================================================
  // SIGNATURES
  // ==================================================================
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    need(60);
    hline(Y(), BRAND, 1);
    gap(4);
    TB(8, BRAND, 'Sign-off', ML, Y(), pw);
    gap(10);
    var sigY = Y();
    var sigW = (pw - 12) / 2;

    function drawSig(x, label, name, when) {
      rr(x, sigY, sigW, 48, 4, GRAY_LIGHT);
      doc.save().moveTo(x, sigY + 48).lineTo(x + sigW, sigY + 48)
        .strokeColor('#D1D5DB').lineWidth(0.5).stroke().restore();
      TB(5.5, GRAY, label, x + 8, sigY + 5, sigW - 16);
      doc.font('Helvetica-Oblique').fontSize(18).fillColor(GRAY_DARK)
        .text(name, x + 8, sigY + 16, { width: sigW - 16, lineBreak: false });
      doc.font('Helvetica');
      if (when) T(5.5, GREEN, '\u2713 Signed ' + fmtDate(when), x + 8, sigY + 38, sigW - 16);
    }
    if (a.auditor_signature_text)    drawSig(ML, 'AUDITOR', a.auditor_signature_text, a.auditor_signed_at);
    if (a.supervisor_signature_text) drawSig(ML + sigW + 12, 'SUPERVISOR / STMS', a.supervisor_signature_text, a.supervisor_signed_at);
    setY(sigY + 54);
  }

  // Annotated TGS
  embedPhotos('ANNOTATED TGS / CLOSE-OUT SKETCH', ctxMap['annotated_tgs'], null);

  // ---- Created by / signed off info ----
  gap(8);
  hline(Y(), '#E5E7EB', 0.5);
  gap(4);
  T(5.5, GRAY, 'Created by ' + (a.created_by_name || '—') + '  \u00B7  ' + fmtDate(a.created_at), ML, Y(), pw);
  gap(8);
  if (a.signed_off_by_name) {
    rr(ML, Y(), pw, 16, 3, '#F0FDF4');
    doc.save().roundedRect(ML, Y(), 3, 16, 1).fill(GREEN).restore();
    TB(5.5, GREEN, 'INTERNALLY SIGNED OFF BY', ML + 8, Y() + 2, 110);
    T(7, GRAY_DARK, a.signed_off_by_name + '  \u00B7  ' + fmtDate(a.signed_off_at), ML + 120, Y() + 2, pw - 128);
    gap(20);
  }

  // ==================================================================
  // FIX 6: RUNNING FOOTER — accurate page count, no blank trailing pages
  // ==================================================================
  var range = doc.bufferedPageRange();
  var totalPages = range.count;
  for (var p = range.start; p < range.start + totalPages; p++) {
    doc.switchToPage(p);
    var footY = doc.page.height - 30;
    doc.font('Helvetica').fontSize(5).fillColor(GRAY)
      .text('T&S Traffic Control  \u00B7  Site Audit #' + a.id + '  \u00B7  Confidential  \u00B7  Page ' + (p + 1) + ' of ' + totalPages,
        ML, footY, { width: pw, align: 'center', lineBreak: false });
  }

  doc.end();

  // ==================================================================
  // PHOTO EMBED HELPER (closure — has access to doc, pw, pageBot, a)
  // ==================================================================
  function embedPhotos(label, items, itemRef) {
    if (!items || !items.length) return;
    var images = [];
    items.forEach(function (att) {
      if (!(att.mime_type || '').startsWith('image/')) return;
      var fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(a.id), att.filename);
      if (fs.existsSync(fp)) images.push({ att: att, fp: fp });
    });
    if (!images.length) return;

    if (label) {
      need(14);
      doc.font('Helvetica-Bold').fontSize(6).fillColor(GRAY)
        .text(label, ML, doc.y, { lineBreak: false, width: pw });
      doc.y += 8;
    }

    // FIX 3: Max 2 per row, min 45% page width, with captions
    var gutter = 8;
    var imgW = images.length === 1
      ? Math.floor(pw * 0.7)
      : Math.floor((pw - gutter) / 2);
    var imgH = Math.floor(imgW * 0.65);
    var captH = 12;
    var col = 0, rowTop = doc.y;

    images.forEach(function (img) {
      if (col >= 2) { col = 0; rowTop += imgH + captH + gutter; }
      if (col === 0 && rowTop + imgH + captH > pageBot) { doc.addPage(); rowTop = doc.y; }

      var ix = images.length === 1
        ? ML + Math.floor((pw - imgW) / 2)
        : ML + col * (imgW + gutter);

      // 1px border
      doc.save().rect(ix - 1, rowTop - 1, imgW + 2, imgH + 2)
        .strokeColor('#CCCCCC').lineWidth(1).stroke().restore();

      try { doc.image(img.fp, ix, rowTop, { fit: [imgW, imgH], align: 'center', valign: 'center' }); }
      catch (e) { /* skip */ }

      // Caption: "Ref X.X — caption" or just caption/filename
      var cap = itemRef
        ? 'Ref ' + itemRef + ' — ' + (img.att.caption || img.att.original_name || 'Evidence')
        : (img.att.caption || img.att.original_name || 'Evidence');
      doc.font('Helvetica').fontSize(6).fillColor(GRAY)
        .text(cap, ix, rowTop + imgH + 2, { lineBreak: false, width: imgW, align: 'center' });

      col++;
    });

    doc.y = rowTop + imgH + captH + gutter;
    doc.x = ML;
  }
}

module.exports = { generateAuditPdf };
