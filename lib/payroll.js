// Payroll helpers — CSV parsing for Traffio Person Dockets export, plus
// per-line aggregation logic that buckets a worker's shifts into the Cash /
// TFN / ABN payroll sheet shape: 7-day Mon..Sun split, day vs night, with
// rates snapshotted from the employees table.
//
// The Traffio CSV is fully quoted with commas inside fields rare but possible
// (booking_address can contain commas). Parser handles "" as escaped quote.

'use strict';

// ----------------------------------------------------------------------------
// CSV parser — single function, handles quoted fields and embedded commas.
// Returns { headers: [...], rows: [{col: value, ...}] }.
// ----------------------------------------------------------------------------
function parseCsv(text) {
  if (!text || typeof text !== 'string') return { headers: [], rows: [] };
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const records = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      // Skip empty trailing rows
      if (!(row.length === 1 && row[0] === '')) records.push(row);
      row = []; i++; continue;
    }
    field += ch; i++;
  }
  // Flush final field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) records.push(row);
  }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map(h => (h || '').trim());
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.every(v => !v || !String(v).trim())) continue; // skip blank
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (rec[c] !== undefined ? rec[c] : '');
    rows.push(obj);
  }
  return { headers, rows };
}

// ----------------------------------------------------------------------------
// Day-of-week helper — convert ISO date (YYYY-MM-DD) to 0..6 with 0 = Monday.
// Returns -1 if invalid.
// ----------------------------------------------------------------------------
function dowMonFirst(isoDate) {
  if (!isoDate) return -1;
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return -1;
  // JS Date.getDay: Sun=0..Sat=6 → shift so Mon=0..Sun=6
  const js = d.getDay();
  return (js + 6) % 7;
}

// ----------------------------------------------------------------------------
// Day vs Night classification — based on shift start time.
//   Night if start hour >= 18 (6 PM) OR < 6 (before 6 AM)
//   Day otherwise.
// time_on like "07:00:00", "20:00:00", "06:30:00".
// ----------------------------------------------------------------------------
function isNightShift(timeOn) {
  if (!timeOn) return false;
  const m = String(timeOn).match(/^(\d{1,2}):/);
  if (!m) return false;
  const hr = parseInt(m[1], 10);
  if (isNaN(hr)) return false;
  return hr >= 18 || hr < 6;
}

// ----------------------------------------------------------------------------
// Parse a single Traffio row into a normalized shift descriptor.
// Returns null if the row should be excluded (deleted, excluded from payrun, no hours).
// ----------------------------------------------------------------------------
function normalizeShift(row) {
  if (!row) return null;
  const isDeleted = String(row.is_deleted || '').trim() === '1';
  const excluded = String(row.person_exclude_from_payrun || '').trim() === '1';
  if (isDeleted || excluded) return null;

  const hours = parseFloat(row.hours_worked);
  if (!isFinite(hours) || hours <= 0) return null;

  const personId = String(row.person_id || '').trim();
  const fullName = (row.full_name || '').trim() ||
                   ((row.first_name || '') + ' ' + (row.last_name || '')).trim();
  if (!fullName) return null;

  const dateIso = String(row.time_on_date || '').trim();
  const timeOn = String(row.time_on_time || '').trim();
  const dow = dowMonFirst(dateIso);
  if (dow < 0) return null;

  return {
    person_id: personId,
    full_name: fullName,
    first_name: (row.first_name || '').trim(),
    last_name: (row.last_name || '').trim(),
    employee_reference: (row.employee_reference || '').trim(),
    is_subcontractor: String(row.person_is_sub_contractor || '').trim() === '1',
    booking_id: (row.booking_id || '').trim(),
    job_number: (row.job_number || '').trim(),
    client_name: (row.client_name || '').trim(),
    project_name: (row.project_name || '').trim(),
    booking_address: (row.booking_address || '').trim(),
    date: dateIso,
    time_on: timeOn,
    time_off: (row.time_off_time || '').trim(),
    hours,
    dow,
    night: isNightShift(timeOn),
    notes: (row.works_docket_notes || '').trim(),
  };
}

// ----------------------------------------------------------------------------
// Aggregate a list of shifts (already normalized) into per-worker totals.
// Returns Array<{
//   person_id, full_name, first_name, last_name, employee_reference,
//   day_hours: [7], night_hours: [7],
//   total_day_hours, total_night_hours, total_hours,
//   shifts: [...]
// }>
// Sorted alphabetically by full_name.
// ----------------------------------------------------------------------------
function aggregateByWorker(shifts) {
  const map = new Map();
  for (const s of shifts) {
    if (!s) continue;
    // Key by person_id when present, else by lower-cased full_name to merge
    // duplicates from the CSV. Traffio gives a stable person_id so this is safe.
    const key = s.person_id ? `pid:${s.person_id}` : `name:${s.full_name.toLowerCase()}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        person_id: s.person_id || '',
        full_name: s.full_name,
        first_name: s.first_name,
        last_name: s.last_name,
        employee_reference: s.employee_reference,
        is_subcontractor: !!s.is_subcontractor,
        day_hours: [0, 0, 0, 0, 0, 0, 0],
        night_hours: [0, 0, 0, 0, 0, 0, 0],
        total_day_hours: 0,
        total_night_hours: 0,
        total_hours: 0,
        shifts: [],
      };
      map.set(key, agg);
    }
    if (s.night) {
      agg.night_hours[s.dow] = round2(agg.night_hours[s.dow] + s.hours);
      agg.total_night_hours = round2(agg.total_night_hours + s.hours);
    } else {
      agg.day_hours[s.dow] = round2(agg.day_hours[s.dow] + s.hours);
      agg.total_day_hours = round2(agg.total_day_hours + s.hours);
    }
    agg.total_hours = round2(agg.total_hours + s.hours);
    agg.shifts.push({
      booking_id: s.booking_id,
      job_number: s.job_number,
      date: s.date,
      time_on: s.time_on,
      time_off: s.time_off,
      hours: s.hours,
      dow: s.dow,
      night: s.night,
      client_name: s.client_name,
      project_name: s.project_name,
      booking_address: s.booking_address,
      notes: s.notes,
    });
  }
  const list = Array.from(map.values());
  list.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en-AU', { sensitivity: 'base' }));
  return list;
}

// ----------------------------------------------------------------------------
// Compute period_start / period_end from a list of normalized shifts.
// Period is the Mon→Sun bracket containing the EARLIEST shift date.
// Falls back to the latest if shifts span multiple weeks (warns later).
// ----------------------------------------------------------------------------
function inferPeriod(shifts) {
  const dates = shifts.map(s => s.date).filter(Boolean).sort();
  if (dates.length === 0) {
    const today = formatLocalDate(new Date());
    return { period_start: today, period_end: today, dates: [] };
  }
  const earliest = dates[0];
  const d = new Date(earliest + 'T00:00:00');
  // Snap to Monday
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const start = formatLocalDate(d);
  d.setDate(d.getDate() + 6);
  const end = formatLocalDate(d);
  return { period_start: start, period_end: end, dates };
}

// Format a Date as YYYY-MM-DD in LOCAL time (not UTC). toISOString shifts by
// timezone offset which corrupts the date in AU timezones — avoid it.
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ----------------------------------------------------------------------------
// Match an aggregated worker against the employees table. Strategy:
//   1. employee_reference == employees.employee_code
//   2. exact lower(full_name) match
//   3. lower(first_name) + lower(last_name) match
//   4. nothing → leave employee_id null (Unclassified bucket)
// Returns the matched employee row or null.
// ----------------------------------------------------------------------------
function matchEmployee(db, agg) {
  if (agg.employee_reference) {
    const r = db.prepare(
      'SELECT * FROM employees WHERE employee_code = ? AND active = 1 LIMIT 1'
    ).get(agg.employee_reference);
    if (r) return r;
  }
  const lower = agg.full_name.toLowerCase();
  let r = db.prepare(
    'SELECT * FROM employees WHERE LOWER(full_name) = ? AND active = 1 LIMIT 1'
  ).get(lower);
  if (r) return r;
  if (agg.first_name && agg.last_name) {
    r = db.prepare(
      'SELECT * FROM employees WHERE LOWER(first_name) = ? AND LOWER(last_name) = ? AND active = 1 LIMIT 1'
    ).get(agg.first_name.toLowerCase(), agg.last_name.toLowerCase());
    if (r) return r;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Build a pay_run_line row (object, ready for INSERT) from an aggregated
// worker + matched employee. Snapshots rates, payment_type, BSB at this moment
// so the historical run is immutable.
// ----------------------------------------------------------------------------
function buildLine({ pay_run_id, agg, employee }) {
  const rateDay = employee ? toNum(employee.rate_day) : 0;
  const rateNight = employee ? toNum(employee.rate_night) : 0;
  const totalDayWages = round2(agg.total_day_hours * rateDay);
  const totalNightWages = round2(agg.total_night_hours * rateNight);
  const totalWages = round2(totalDayWages + totalNightWages);

  // Default payment_type from employee record (cash/tfn/abn) — falls back to ''.
  // If unmatched but the CSV says is_subcontractor=1, hint at 'abn' on import.
  let paymentType = (employee && employee.payment_type) ? String(employee.payment_type).toLowerCase() : '';
  if (!paymentType && agg.is_subcontractor) paymentType = 'abn';
  if (!['cash', 'tfn', 'abn'].includes(paymentType)) paymentType = '';

  return {
    pay_run_id,
    employee_id: employee ? employee.id : null,
    person_id: agg.person_id,
    full_name: agg.full_name,
    payment_type: paymentType,
    bsb: employee ? (employee.payroll_bsb || '') : '',
    acc_number: employee ? (employee.payroll_account || '') : '',
    day_hours_json: JSON.stringify(agg.day_hours),
    night_hours_json: JSON.stringify(agg.night_hours),
    total_day_hours: agg.total_day_hours,
    total_night_hours: agg.total_night_hours,
    total_hours: agg.total_hours,
    rate_day: rateDay,
    rate_night: rateNight,
    total_day_wages: totalDayWages,
    total_night_wages: totalNightWages,
    total_wages: totalWages,
    travel_allowance: 0,
    meal_allowance: 0,
    other_allowance: 0,
    total_allowance: 0,
    grand_total: totalWages,
    paid: 0,
    paid_ref: '',
    paid_at: null,
    notes: '',
    shifts_json: JSON.stringify(agg.shifts),
    sort_order: 0,
  };
}

// ----------------------------------------------------------------------------
// Recompute totals on a single line — call after any user edit to hours, rates,
// or allowances. Returns a partial object with all derived fields.
// ----------------------------------------------------------------------------
function recomputeLine(line) {
  let dayHours = [0, 0, 0, 0, 0, 0, 0];
  let nightHours = [0, 0, 0, 0, 0, 0, 0];
  try { dayHours = JSON.parse(line.day_hours_json || '[]'); if (!Array.isArray(dayHours) || dayHours.length !== 7) dayHours = [0, 0, 0, 0, 0, 0, 0]; } catch (e) {}
  try { nightHours = JSON.parse(line.night_hours_json || '[]'); if (!Array.isArray(nightHours) || nightHours.length !== 7) nightHours = [0, 0, 0, 0, 0, 0, 0]; } catch (e) {}

  const totalDayHours = round2(sum(dayHours));
  const totalNightHours = round2(sum(nightHours));
  const totalHours = round2(totalDayHours + totalNightHours);
  const rateDay = toNum(line.rate_day);
  const rateNight = toNum(line.rate_night);
  const totalDayWages = round2(totalDayHours * rateDay);
  const totalNightWages = round2(totalNightHours * rateNight);
  const totalWages = round2(totalDayWages + totalNightWages);
  const travel = toNum(line.travel_allowance);
  const meal = toNum(line.meal_allowance);
  const other = toNum(line.other_allowance);
  const totalAllowance = round2(travel + meal + other);
  const grandTotal = round2(totalWages + totalAllowance);

  return {
    day_hours_json: JSON.stringify(dayHours.map(round2)),
    night_hours_json: JSON.stringify(nightHours.map(round2)),
    total_day_hours: totalDayHours,
    total_night_hours: totalNightHours,
    total_hours: totalHours,
    total_day_wages: totalDayWages,
    total_night_wages: totalNightWages,
    total_wages: totalWages,
    total_allowance: totalAllowance,
    grand_total: grandTotal,
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function round2(n) { const v = parseFloat(n); if (!isFinite(v)) return 0; return Math.round(v * 100) / 100; }
function toNum(n) { const v = parseFloat(n); return isFinite(v) ? v : 0; }
function sum(arr) { let t = 0; for (const v of (arr || [])) t += toNum(v); return t; }

module.exports = {
  parseCsv,
  dowMonFirst,
  isNightShift,
  normalizeShift,
  aggregateByWorker,
  inferPeriod,
  matchEmployee,
  buildLine,
  recomputeLine,
  formatLocalDate,
  round2,
  toNum,
  sum,
};
