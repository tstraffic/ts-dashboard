// Sydney-timezone date helpers.
//
// Railway's container clock runs on UTC, so `new Date().toISOString()` lands
// on the wrong day for several hours every Sydney evening — Monday 9am
// Sydney was rendering as the previous Sunday for any worker hitting the
// portal between 14:00–23:59 UTC. Everything user-facing (today's shift,
// "Coming up" tab, week strip "today" highlight, docket date defaults) has
// to compute the date in Sydney time instead.
//
// Uses Intl.DateTimeFormat with timeZone: 'Australia/Sydney' which handles
// DST automatically without us shipping a timezone library.

const TZ = 'Australia/Sydney';

function sydneyToday(date) {
  const d = date || new Date();
  // en-CA locale outputs YYYY-MM-DD by default, which is exactly what we
  // want for SQLite date comparisons.
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

// Sydney-local date for any JS Date (or now).
function sydneyIso(date) {
  return sydneyToday(date);
}

// Day-of-week in Sydney (0 = Sunday, 6 = Saturday).
function sydneyDow(date) {
  const d = date || new Date();
  // Format the weekday short name then map.
  const wd = d.toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'short' });
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wd);
}

// Detect a YYYY-MM-DD string (date column from SQLite). Plain dates have
// no timezone — formatting them through Sydney would shift them across
// midnight in some browsers, so we render them as-is.
function isPlainDateString(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && v.length === 10;
}

function _toDate(input) {
  if (input == null || input === '') return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  // SQLite emits CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' (UTC, no Z).
  // Replace the space with 'T' and append Z so JS treats it as UTC.
  let s = String(input);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// DD/MM/YYYY in Sydney. Plain date strings (no time component) bypass TZ
// conversion to avoid spurious off-by-one shifts.
function formatDateAU(input) {
  if (input == null || input === '') return '';
  if (isPlainDateString(input)) {
    const [y, m, d] = input.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = _toDate(input);
  if (!d) return String(input);
  return d.toLocaleDateString('en-AU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}

// DD Mon YYYY (e.g. 06 May 2026) in Sydney.
function formatDateShortAU(input) {
  if (input == null || input === '') return '';
  if (isPlainDateString(input)) {
    const d = new Date(input + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  const d = _toDate(input);
  if (!d) return String(input);
  return d.toLocaleDateString('en-AU', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

// DD/MM/YYYY HH:MM in Sydney — for created_at / updated_at / submitted_at
// timestamps that need wall-clock time.
function formatDateTimeAU(input) {
  if (input == null || input === '') return '';
  const d = _toDate(input);
  if (!d) return String(input);
  return d.toLocaleString('en-AU', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// HH:MM in Sydney.
function formatTimeAU(input) {
  if (input == null || input === '') return '';
  const d = _toDate(input);
  if (!d) return String(input);
  return d.toLocaleTimeString('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

module.exports = {
  TZ,
  sydneyToday, sydneyIso, sydneyDow,
  formatDateAU, formatDateShortAU, formatDateTimeAU, formatTimeAU,
};
