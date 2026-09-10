// NSW E-Toll "Statement/Tax Invoice" PDF → structured trips per tag / plate.
//
// Parsing is best-effort by design: the result feeds the review modal on
// /fleet/tolls, where the office corrects anything before it is applied to
// vehicles. Text positions come from pdfjs. The statement's tables leave
// columns blank (a tag row has no LPN, a plate row has no tag), so identity
// columns are read by x-window and the money columns right-to-left.
//
// Imports no DB module on purpose (lint ratchet): takes a path, returns data.
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const PARSER_VERSION = 1;

class TollParseError extends Error {
  constructor(message) { super(message); this.name = 'TollParseError'; }
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MONEY_RE = /^\(?-?\$?-?[\d,]*\d\.\d{2}\)?(CR)?$/i;
const INT_RE = /^\d+$/;
const FEE_RE = /\bfee\b|toll notice|video matching/i;
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// x windows (points) — stable across both 2026 statements we have.
const X = { tagMax: 80, refMax: 180, plateMax: 270, stateMax: 330, descMin: 130, classMin: 380, classMax: 500, marginX: 575 };

const isNumTok = (s) => MONEY_RE.test(s) || INT_RE.test(s);

function money(s) {
  if (s == null) return null;
  let t = String(s).trim();
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/CR$/i.test(t)) { neg = true; t = t.replace(/CR$/i, ''); }
  t = t.replace(/[$,\s]/g, '');
  while (t.startsWith('-')) { neg = !neg; t = t.slice(1); }
  const v = parseFloat(t);
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}
const round2 = (n) => Math.round(n * 100) / 100;

function isoFromDMY(s) {
  const m = DATE_RE.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
function isoFromLong(s) {
  const m = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

/** Every page as ordered lines of x-positioned tokens. */
async function extractPages(absPath) {
  const data = new Uint8Array(fs.readFileSync(absPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }))
      // The rotated document id printed down the right margin shares a
      // baseline with whichever row it lands on — never part of the table.
      .filter(it => it.x < X.marginX && !/_Email_/.test(it.s))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!cur || Math.abs(cur.y - it.y) > 2.5) { cur = { y: it.y, toks: [] }; lines.push(cur); }
      cur.toks.push(it);
    }
    lines.forEach(l => { l.toks.sort((a, b) => a.x - b.x); l.text = l.toks.map(t => t.s).join(' '); });
    pages.push(lines);
  }
  return { pages, pageCount: doc.numPages };
}

function parseFrontPage(lines) {
  const text = lines.map(l => l.text).join('\n');
  const grab = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const number = grab(/Invoice No[\s\S]{0,80}?(?<!\d)(\d{8,})(?!\d)/);
  // The period value shares a text line with the 'Balance' figure, so match the
  // only date range on the front page rather than anchoring on the label.
  const period = /(\d{1,2} [A-Za-z]{3} \d{4})\s*[-\u2013\u2014]\s*(\d{1,2} [A-Za-z]{3} \d{4})/.exec(text);
  return {
    number,
    accountNumber: grab(/Account No[\s\S]{0,80}?(?<!\d)(\d{6,})(?!\d)/),
    issueDate: isoFromLong(grab(/Issue Date[\s\S]{0,80}?(?<!\d)(\d{1,2} [A-Za-z]{3} \d{4})/)),
    periodStart: period ? isoFromLong(period[1]) : null,
    periodEnd: period ? isoFromLong(period[2]) : null,
    // Statement-level figures, kept for display. They don't reconcile to the
    // per-vehicle listing even on genuine statements (E-Toll re-attributes
    // video-matched trips between its summary and its detail), so the
    // attributable totals come from the listed rows instead.
    totalCharges: Math.abs(money(grab(/Total toll charges\s+(\(?-?\$?[\d,]+\.\d{2}\)?)/)) || 0) || null,
    accountFees: Math.abs(money(grab(/Total fees, charges & adjustments\s+(\(?-?\$?[\d,]+\.\d{2}\)?)/)) || 0) || null,
    gst: Math.abs(money(grab(/Includes GST\**\s+of\s+(\(?-?\$?[\d,]+\.\d{2}\)?)/)) || 0) || null,
  };
}

/**
 * Parse an E-Toll statement. Resolves to
 *   { invoice, summary:[...], sections:[...], warnings:[...] }
 * or throws TollParseError when the file isn't an E-Toll statement.
 */
async function parseTollInvoice(absPath) {
  const { pages, pageCount } = await extractPages(absPath);
  if (!pages.length) throw new TollParseError('The PDF has no readable text.');
  const invoice = { ...parseFrontPage(pages[0]), pageCount };
  if (!invoice.number) throw new TollParseError("This doesn't look like an E-Toll statement (no Invoice No found).");

  const warnings = [];
  const summaryByKey = {};      // key → summary row (merged)
  const summaryOrder = [];
  const sectionsByKey = {};
  const sections = [];
  let mode = null;              // 'summary' | 'payments' | 'details'
  let current = null;           // open detail section
  let lastRow = null;
  let sawDetails = false;

  const openSection = (kind, rawRef, continued, totalTrips) => {
    const ref = kind === 'tag' ? String(rawRef).replace(/\D/g, '') : norm(rawRef);
    const key = kind + ':' + ref;
    let sec = sectionsByKey[key];
    if (!sec) {
      sec = { key, kind, ref, label: null, totalTrips: totalTrips != null ? Number(totalTrips) : null, totalForVehicle: null, rows: [] };
      sectionsByKey[key] = sec;
      sections.push(sec);
    } else if (!continued) {
      warnings.push(`Section ${kind} ${ref} appears twice in the detailed statement; rows were merged.`);
    }
    current = sec;
    lastRow = null;
  };

  for (const lines of pages) {
    for (const line of lines) {
      const text = line.text;
      const toks = line.toks;

      if (/^Summary use of toll charges/i.test(text)) { mode = 'summary'; continue; }
      if (/^Payments, account fees and adjustments/i.test(text)) { mode = 'payments'; continue; }
      if (/^Detailed statement/i.test(text)) { mode = 'details'; sawDetails = true; continue; }
      if (/^Page \d+ of \d+$/i.test(text)) continue;

      if (mode === 'summary') {
        if (/^Tag\b.*Reference/i.test(text)) continue;                  // column header
        if (toks.length < 5) continue;
        const tail = toks.slice(-4);
        if (!tail.every(t => isNumTok(t.s))) continue;
        const lead = toks.slice(0, -4);
        const inWin = (lo, hi) => lead.filter(t => t.x >= lo && t.x < hi).map(t => t.s).join(' ').trim();
        const tag = inWin(0, X.tagMax).replace(/\D/g, '');
        const reference = inWin(X.tagMax, X.refMax);
        const plate = inWin(X.refMax, X.plateMax);
        const state = inWin(X.plateMax, X.stateMax);
        let kind, ref;
        if (plate) { kind = 'plate'; ref = norm(plate); }
        else if (tag) { kind = 'tag'; ref = tag; }
        else continue;
        const key = kind + ':' + ref;
        const row = { trips: parseInt(tail[0].s, 10) || 0, tolls: money(tail[1].s) || 0, fees: money(tail[2].s) || 0, total: money(tail[3].s) || 0 };
        if (summaryByKey[key]) {
          const s = summaryByKey[key];
          s.trips += row.trips; s.tolls = round2(s.tolls + row.tolls); s.fees = round2(s.fees + row.fees); s.total = round2(s.total + row.total);
        } else {
          summaryByKey[key] = { key, kind, ref, label: kind === 'tag' ? (reference || null) : null, state: state || null, ...row };
          summaryOrder.push(key);
        }
        continue;
      }

      if (mode !== 'details') continue;

      let m = /^(Tag Number|Licence Plate No):\s*(.+?)(\s+-\s+continued)?(?:\s+Total Trips:\s*(\d+))?\s*$/i.exec(text);
      if (m) {
        openSection(/^Tag/i.test(m[1]) ? 'tag' : 'plate', m[2], !!m[3], m[4]);
        continue;
      }
      if (/^Total for (Vehicle|Tag)\b/i.test(text)) {
        if (current) current.totalForVehicle = money(toks[toks.length - 1].s);
        current = null; lastRow = null;
        continue;
      }
      if (!current) continue;
      if (/^Date\b.*Amount/i.test(text)) continue;                       // column header

      if (DATE_RE.test(toks[0].s)) {
        const last = toks[toks.length - 1];
        const hasAmount = toks.length > 1 && isNumTok(last.s) && last.x >= X.classMax;
        const time = toks[1] && TIME_RE.test(toks[1].s) ? toks[1].s : '';
        const body = toks.slice(time ? 2 : 1, hasAmount ? -1 : undefined);
        const classToks = body.filter(t => t.x >= X.classMin && t.x < X.classMax);
        const descToks = body.filter(t => !(t.x >= X.classMin && t.x < X.classMax));
        const description = descToks.map(t => t.s).join(' ').trim();
        const row = {
          i: current.rows.length,
          date: isoFromDMY(toks[0].s),
          time,
          description,
          vehicleClass: classToks.map(t => t.s).join(' ') || null,
          amount: hasAmount ? money(last.s) : null,
          isFee: FEE_RE.test(description),
        };
        current.rows.push(row);
        lastRow = row;
        continue;
      }

      // Wrapped description (all tokens inside the Start–Finish column) or
      // an amount that wrapped onto its own line.
      if (lastRow) {
        if (toks.every(t => t.x >= X.descMin && t.x < X.classMin)) {
          lastRow.description = (lastRow.description + ' ' + text).trim();
          lastRow.isFee = FEE_RE.test(lastRow.description);
          continue;
        }
        if (lastRow.amount == null && toks.length === 1 && isNumTok(toks[0].s) && toks[0].x >= X.classMax) {
          lastRow.amount = money(toks[0].s);
          continue;
        }
      }
    }
  }

  if (!sawDetails) throw new TollParseError("This doesn't look like an E-Toll statement (no detailed statement found).");

  // Per-section rollups + validation. Fee rows are the video-matching /
  // toll-notice charges printed alongside the trips they belong to.
  sections.forEach(sec => {
    const sum = summaryByKey[sec.key];
    if (sum && sum.label) sec.label = sum.label;
    sec.rows.forEach(r => { if (r.amount == null) { r.amount = 0; warnings.push(`${sec.kind} ${sec.ref}: a row on ${r.date || '?'} had no readable amount and was set to $0.`); } });
    const tolls = round2(sec.rows.filter(r => !r.isFee).reduce((s, r) => s + r.amount, 0));
    const fees = round2(sec.rows.filter(r => r.isFee).reduce((s, r) => s + r.amount, 0));
    const total = round2(tolls + fees);
    sec.trips = sec.rows.filter(r => !r.isFee).length;
    sec.tolls = tolls; sec.fees = fees; sec.total = total;
    sec.sumMatches = sec.totalForVehicle == null ? null : Math.abs(total - sec.totalForVehicle) <= 0.011;
    if (sec.sumMatches === false) {
      const who = (sec.kind === 'tag' ? 'Tag ' : 'Plate ') + sec.ref;
      const counted = sum ? ` (E-Toll's summary counts ${sum.trips} trips)` : '';
      warnings.push(`${who}: the listed trips add to $${total.toFixed(2)}, the statement's total for it is $${sec.totalForVehicle.toFixed(2)}${counted}. The listed trips are what gets added.`);
    }
  });
  summaryOrder.forEach(key => {
    const s = summaryByKey[key];
    if (s.trips > 0 && !sectionsByKey[key]) warnings.push(`${s.kind === 'tag' ? 'Tag' : 'Plate'} ${s.ref} shows ${s.trips} trips in the summary but no detailed section was found.`);
  });

  invoice.totalTolls = round2(sections.reduce((s, sec) => s + sec.tolls, 0));
  invoice.totalFees = round2(sections.reduce((s, sec) => s + sec.fees, 0));
  invoice.tripCount = sections.reduce((s, sec) => s + sec.trips, 0);

  return { invoice, summary: summaryOrder.map(k => summaryByKey[k]), sections, warnings, parserVersion: PARSER_VERSION };
}

/** Slim per-section headers for the invoice list (no rows). */
function summarise(parsed) {
  const withSections = new Set(parsed.sections.map(s => s.key));
  const rows = parsed.sections.map(s => ({
    key: s.key, kind: s.kind, ref: s.ref, label: s.label, trips: s.trips, rowCount: s.rows.length,
    tolls: s.tolls, fees: s.fees, total: s.total, totalForVehicle: s.totalForVehicle, sumMatches: s.sumMatches,
  }));
  parsed.summary.filter(s => !withSections.has(s.key)).forEach(s => rows.push({
    key: s.key, kind: s.kind, ref: s.ref, label: s.label, trips: s.trips, rowCount: 0, tolls: s.tolls, fees: s.fees, total: s.total, totalForVehicle: null, sumMatches: null,
  }));
  return rows;
}

module.exports = { parseTollInvoice, summarise, extractPages, money, norm, TollParseError, PARSER_VERSION };
