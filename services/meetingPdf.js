// Meeting minutes PDF — renders a company or client meeting into a branded
// A4 document: meta block (date / time / client / attendees), the structured
// minutes (user-authored headings → dot points), photos embedded with their
// captions, non-image files listed by name, and — for company meetings —
// the legacy discussion items + action items when present.
//
// Images: pdfkit only understands PNG and JPEG, and phone photos arrive as
// HEIC/WebP with EXIF rotation. Every image is normalised through sharp
// (rotate → resize → JPEG) before embedding; a file sharp can't read
// degrades to a note instead of killing the export.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const BRAND = '#059669';
const BRAND_DARK = '#065F46';
const INK = '#1F2937';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const RULE = '#E5E7EB';
const PANEL = '#F9FAFB';

const ML = 48, MR = 48, MT = 52, MB = 58;
const A4W = 595.28;
const CW = A4W - ML - MR;
const LOGO = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');

// A heading must never be the last thing on a page.
const KEEP_WITH_NEXT = 60;

function need(doc, h) {
  if (doc.y + h > doc.page.height - MB) { doc.addPage(); return true; }
  return false;
}

function absUpload(rel) {
  return path.join(__dirname, '..', String(rel || '').replace(/^\/+/, ''));
}

function fmtTime12(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  let h = parseInt(m[1], 10);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m[2] + ' ' + ap;
}

function fmtDateLong(iso) {
  const m = String(iso || '').match(/^\d{4}-\d{2}-\d{2}$/);
  if (!m) return String(iso || '');
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// Normalise any uploaded image to a JPEG buffer pdfkit can embed, plus its
// aspect ratio for layout. Returns null when the file is unreadable.
async function prepareImage(relPath) {
  try {
    const sharp = require('sharp');
    const abs = absUpload(relPath);
    if (!fs.existsSync(abs)) return null;
    const img = sharp(abs).rotate(); // EXIF orientation baked in
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return null;
    const buf = await img.resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
    const scaledW = Math.min(meta.width, 1400);
    const scaledH = Math.round(meta.height * (scaledW / meta.width));
    return { buf, width: scaledW, height: scaledH };
  } catch (e) {
    console.error('[meetingPdf] image prepare failed for', relPath, ':', e.message);
    return null;
  }
}

function drawCaption(doc, caption) {
  if (!caption) return;
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.6)
    .text(caption, ML + 8, doc.y, { width: CW - 16, lineGap: 1.5, align: 'center' });
  doc.y += 4;
}

// Draw one image block (bordered, centred, caption under). Adds a page
// first when the image + caption won't fit in the remaining space.
function drawImage(doc, prepared, caption) {
  const maxW = CW - 16;
  const maxH = 320;
  let w = prepared.width, h = prepared.height;
  const scale = Math.min(maxW / w, maxH / h, 1);
  w = w * scale; h = h * scale;

  doc.font('Helvetica-Oblique').fontSize(8.6);
  const capH = caption ? doc.heightOfString(caption, { width: CW - 16 }) + 6 : 0;
  need(doc, h + capH + 16);

  const x = ML + (CW - w) / 2;
  doc.image(prepared.buf, x, doc.y, { width: w, height: h });
  doc.rect(x, doc.y, w, h).lineWidth(0.6).strokeColor(RULE).stroke();
  doc.y += h + 5;
  drawCaption(doc, caption);
  doc.y += 6;
}

function drawFileLine(doc, att, indent) {
  need(doc, 16);
  const label = 'Attachment: ' + (att.original_name || 'file') + (att.size_bytes ? '  (' + fmtSize(att.size_bytes) + ')' : '');
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.6)
    .text(label + (att.caption ? ' — ' + att.caption : ''), ML + indent, doc.y, { width: CW - indent, lineGap: 1.5 });
  doc.y += 3;
}

// Render a list of attachments: images embedded, other files listed.
async function drawAttachments(doc, atts, indent) {
  for (const att of atts || []) {
    if (att.is_image) {
      const prepared = await prepareImage(att.file_path);
      if (prepared) { drawImage(doc, prepared, att.caption); continue; }
      need(doc, 16);
      doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(8.6)
        .text('[image unavailable: ' + (att.original_name || att.file_path) + ']', ML + indent, doc.y, { width: CW - indent });
      doc.y += 4;
    } else {
      drawFileLine(doc, att, indent);
    }
  }
}

function sectionHeading(doc, num, title) {
  const label = num + '.  ' + title;
  doc.font('Helvetica-Bold').fontSize(12);
  const h = doc.heightOfString(label, { width: CW });
  need(doc, 12 + h + 10 + KEEP_WITH_NEXT);
  doc.moveDown(0.8);
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12).text(label, ML, doc.y, { width: CW });
  doc.moveTo(ML, doc.y + 3).lineTo(ML + CW, doc.y + 3).lineWidth(0.7).strokeColor(RULE).stroke();
  doc.y += 10;
}

function bulletPoint(doc, text) {
  doc.font('Helvetica').fontSize(10);
  const h = doc.heightOfString(text, { width: CW - 16, lineGap: 2 });
  need(doc, Math.min(h, 40) + 4);
  const y0 = doc.y;
  doc.fillColor(BRAND_DARK).font('Helvetica').fontSize(10).text('•', ML + 2, y0);
  doc.fillColor(INK).font('Helvetica').fontSize(10).text(text, ML + 16, y0, { width: CW - 16, lineGap: 2 });
  doc.y += 4;
}

/**
 * Render a meeting's minutes to a PDF buffer.
 * Loads its own rows (sections/points/attachments, items/todos, client) so
 * the route only hands over the meeting row.
 */
async function renderMeetingPdf(db, meeting) {
  const sections = db.prepare('SELECT * FROM company_meeting_sections WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const points = db.prepare('SELECT * FROM company_meeting_points WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const atts = db.prepare('SELECT * FROM company_meeting_attachments WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const items = db.prepare('SELECT * FROM company_meeting_items WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const todos = db.prepare('SELECT * FROM company_meeting_todos WHERE meeting_id = ? ORDER BY done ASC, position ASC, id ASC').all(meeting.id);
  let clientName = '';
  if (meeting.client_id) {
    try { const c = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(meeting.client_id); if (c) clientName = c.company_name; } catch (e) {}
  }

  const pointsBySection = new Map();
  for (const p of points) {
    if (!pointsBySection.has(p.section_id)) pointsBySection.set(p.section_id, []);
    pointsBySection.get(p.section_id).push(p);
  }
  const attsBySection = new Map();
  const attsByPoint = new Map();
  for (const a of atts) {
    if (a.point_id != null) {
      if (!attsByPoint.has(a.point_id)) attsByPoint.set(a.point_id, []);
      attsByPoint.get(a.point_id).push(a);
    } else if (a.section_id != null) {
      if (!attsBySection.has(a.section_id)) attsBySection.set(a.section_id, []);
      attsBySection.get(a.section_id).push(a);
    }
  }

  const isClient = meeting.meeting_type === 'client';

  return await new Promise(async (resolve, reject) => {
    try {
      // autoFirstPage OFF — the explicit addPage() below is what routes
      // through the pageAdded handler; with the auto page the document
      // opens on a blank page 1 and content starts on page 2.
      const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: false, info: { Title: meeting.title + ' — meeting minutes', Author: 'T&S Traffic Control' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      let firstPage = true;
      doc.on('pageAdded', () => {
        if (firstPage) { firstPage = false; doc.y = MT; return; }
        doc.fillColor(FAINT).font('Helvetica').fontSize(7.5)
          .text(`Meeting minutes · ${meeting.title}`, ML, 24, { width: CW - 90 });
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(7.5)
          .text(fmtDateLong(meeting.meeting_date), ML + CW - 170, 24, { width: 170, align: 'right' });
        doc.moveTo(ML, 36).lineTo(ML + CW, 36).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.y = 48;
      });

      doc.addPage();

      // ── Title block ──
      try { if (fs.existsSync(LOGO)) doc.image(LOGO, ML, doc.y, { height: 34 }); } catch (e) {}
      doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(9)
        .text('T&S TRAFFIC CONTROL', ML + CW - 220, doc.y + 4, { width: 220, align: 'right' });
      doc.fillColor(MUTED).font('Helvetica').fontSize(8)
        .text(isClient ? 'CLIENT MEETING MINUTES' : 'MEETING MINUTES', ML + CW - 220, doc.y + 2, { width: 220, align: 'right' });
      doc.y += 48;

      doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text(meeting.title, ML, doc.y, { width: CW });
      doc.y += 8;

      // ── Meta panel ──
      const meta = [
        ['DATE', fmtDateLong(meeting.meeting_date)],
        ['TIME', fmtTime12(meeting.meeting_time) || '—'],
      ];
      if (isClient) meta.push(['CLIENT', clientName || '—']);
      if (meeting.attendees) meta.push(['ATTENDEES', meeting.attendees]);

      const colW = (CW - 20) / 2;
      const rows = Math.ceil(meta.length / 2);
      doc.font('Helvetica').fontSize(9.5);
      const cellHs = meta.map(([, v]) => 12 + doc.heightOfString(String(v), { width: colW - 20, lineGap: 1.5 }));
      let panelH = 12;
      for (let r = 0; r < rows; r++) panelH += Math.max(cellHs[r * 2] || 0, cellHs[r * 2 + 1] || 0) + 8;
      doc.rect(ML, doc.y, CW, panelH).fillColor(PANEL).fill();
      doc.rect(ML, doc.y, CW, panelH).lineWidth(0.6).strokeColor(RULE).stroke();
      let py = doc.y + 10;
      for (let r = 0; r < rows; r++) {
        let rowH = 0;
        for (let cIdx = 0; cIdx < 2; cIdx++) {
          const entry = meta[r * 2 + cIdx];
          if (!entry) continue;
          const x = ML + 12 + cIdx * (colW + 10);
          doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7).text(entry[0], x, py, { width: colW - 20 });
          doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(String(entry[1]), x, py + 10, { width: colW - 20, lineGap: 1.5 });
          rowH = Math.max(rowH, cellHs[r * 2 + cIdx]);
        }
        py += rowH + 8;
      }
      doc.y = doc.y + panelH + 16;

      // ── Structured minutes ──
      let num = 0;
      for (const sec of sections) {
        num += 1;
        sectionHeading(doc, num, sec.title);
        const secPoints = pointsBySection.get(sec.id) || [];
        for (const p of secPoints) {
          bulletPoint(doc, p.text);
          const pAtts = attsByPoint.get(p.id) || [];
          if (pAtts.length) { doc.y += 2; await drawAttachments(doc, pAtts, 16); }
        }
        if (!secPoints.length) {
          need(doc, 14);
          doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(9).text('No points recorded.', ML + 16, doc.y, { width: CW - 16 });
          doc.y += 6;
        }
        const sAtts = attsBySection.get(sec.id) || [];
        if (sAtts.length) { doc.y += 4; await drawAttachments(doc, sAtts, 0); }
        doc.y += 6;
      }

      // ── Legacy discussion items + to-dos (company meetings) ──
      if (items.length) {
        num += 1;
        sectionHeading(doc, num, 'Discussion items');
        items.forEach((it, i) => bulletPoint(doc, (i + 1) + '. ' + it.body));
        doc.y += 4;
      }
      if (todos.length) {
        num += 1;
        sectionHeading(doc, num, 'Action items');
        for (const t of todos) {
          bulletPoint(doc, (t.done ? '[done] ' : '[open] ') + t.text + (t.priority === 'high' ? '  (HIGH)' : ''));
        }
      }

      if (!sections.length && !items.length && !todos.length) {
        doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(10)
          .text('No minutes recorded for this meeting yet.', ML, doc.y, { width: CW });
      }

      // ── Footers (buffered pages) ──
      const range = doc.bufferedPageRange();
      const generated = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' });
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0; // else the footer text itself triggers a phantom page
        doc.fillColor(FAINT).font('Helvetica').fontSize(7.5)
          .text(`T&S Traffic Control · Meeting minutes · Generated ${generated}`, ML, doc.page.height - 34, { width: CW - 90, lineBreak: false });
        doc.fillColor(FAINT).font('Helvetica').fontSize(7.5)
          .text(`Page ${i - range.start + 1} of ${range.count}`, ML + CW - 80, doc.page.height - 34, { width: 80, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { renderMeetingPdf };
