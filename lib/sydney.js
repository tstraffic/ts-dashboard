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

module.exports = { TZ, sydneyToday, sydneyIso, sydneyDow };
