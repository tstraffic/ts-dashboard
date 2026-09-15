// The daily jobs run on Sydney's clock, not the container's.
//
// Railway runs UTC. Every daily reminder used to be gated on
// `new Date().getHours()`, so "8:00 AM" fired at 08:00 UTC = 6pm Sydney and
// the "induction today" notification landed after a morning induction had
// finished. Fixing the gate alone would have introduced the opposite bug:
// 8am Sydney is the PREVIOUS day in UTC, so a UTC-derived "today" would aim
// every reminder window a day into the past. Both halves are pinned here.
const { test } = require('node:test');
const assert = require('node:assert');
const { sydneyClock, addDaysIso, sydneyToday } = require('../../lib/sydney');

// 22:00 UTC on 14 Sep = 8:00 am Sydney on 15 Sep (AEST, +10).
const EIGHT_AM_SYDNEY = new Date('2026-09-14T22:00:00Z');
// What the old gate actually fired on: 08:00 UTC = 6pm Sydney.
const OLD_FIRING_TIME = new Date('2026-09-15T08:00:00Z');

test('the 8am gate opens at 8am in Sydney, not on the container clock', () => {
  const now = sydneyClock(EIGHT_AM_SYDNEY);
  assert.strictEqual(now.hour, 8);
  assert.strictEqual(now.date, '2026-09-15');
  assert.strictEqual(now.dow, 2);                       // Tuesday

  // The container clock at that instant reads 22:00 — the old gate
  // (getHours() === 8) was shut, which is why nothing fired in the morning.
  assert.strictEqual(EIGHT_AM_SYDNEY.getUTCHours(), 22);
});

test('the gate is shut at the hour it used to fire (6pm Sydney)', () => {
  assert.strictEqual(sydneyClock(OLD_FIRING_TIME).hour, 18);
});

test('reminder windows count from the Sydney day, not the UTC one', () => {
  // The off-by-one that fixing the schedule alone would have caused: at 8am
  // Sydney the UTC calendar still says the 14th.
  assert.strictEqual(sydneyToday(EIGHT_AM_SYDNEY), '2026-09-15');
  assert.strictEqual(EIGHT_AM_SYDNEY.toISOString().slice(0, 10), '2026-09-14');

  const today = sydneyToday(EIGHT_AM_SYDNEY);
  assert.strictEqual(addDaysIso(today, 0), '2026-09-15');   // "induction today"
  assert.strictEqual(addDaysIso(today, 1), '2026-09-16');   // "tomorrow"
  assert.strictEqual(addDaysIso(today, 7), '2026-09-22');
  assert.strictEqual(addDaysIso(today, 30), '2026-10-15');  // cert/SWMS window
});

test('daylight saving never tips a window into the neighbouring day', () => {
  // Sydney moves to AEDT on Sun 4 Oct 2026; a midnight-local anchor plus
  // Date#setDate would land on the 3rd or the 5th around here.
  assert.strictEqual(addDaysIso('2026-10-03', 1), '2026-10-04');
  assert.strictEqual(addDaysIso('2026-10-04', 1), '2026-10-05');
  assert.strictEqual(addDaysIso('2026-09-27', 7), '2026-10-04');
  // …and back to AEST on Sun 5 Apr 2026.
  assert.strictEqual(addDaysIso('2026-04-04', 1), '2026-04-05');
  assert.strictEqual(addDaysIso('2026-04-05', 1), '2026-04-06');
  assert.strictEqual(addDaysIso('2026-12-31', 1), '2027-01-01');   // year roll
  assert.strictEqual(addDaysIso('2026-03-01', -1), '2026-02-28');  // negative
});

test('in daylight saving the Sydney clock is 11 hours ahead, and the gate follows', () => {
  // 21:00 UTC on 14 Jan = 8:00 am Sydney on 15 Jan (AEDT, +11).
  const summerMorning = new Date('2026-01-14T21:00:00Z');
  const now = sydneyClock(summerMorning);
  assert.strictEqual(now.hour, 8);
  assert.strictEqual(now.date, '2026-01-15');
  assert.strictEqual(sydneyToday(summerMorning), '2026-01-15');
});

test('midnight in Sydney reports hour 0, not 24', () => {
  // 13:00 UTC = midnight Sydney (AEST). h23 hourCycle, so this is 0.
  assert.strictEqual(sydneyClock(new Date('2026-09-14T14:00:00Z')).hour, 0);
  assert.strictEqual(sydneyClock(new Date('2026-09-14T14:00:00Z')).date, '2026-09-15');
});
