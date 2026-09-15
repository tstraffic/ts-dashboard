// Liquid Glass — the device systems (bookings board, recruitment, dashboard
// Today board) that don't use the canonical card idiom.
//
//  - the bookings chrome (.bk2-header) is glass; the cards are translucent
//    tint + rim with NO blur (20–30 per board), the status banner stays opaque
//  - the phone blur budget on the busiest page: ≤ 4 blurred layers at rest
//  - the crew-slot acceptance colours are untouched (board-crew-state pins
//    them; this guards the new stylesheet against regressing them)
//  - the segmented-control thumb tracks the active view tab and steps aside
//    under reduced motion
//  - the recruitment tap-to-move sheet is glass and still lands on screen
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}
const css = (loc, prop, pseudo) => loc.evaluate((el, [p, ps]) => getComputedStyle(el, ps || null)[p], [prop, pseudo]);
const alphaOf = (rgba) => { const m = /rgba?\(\s*\d+,\s*\d+,\s*\d+(?:,\s*([\d.]+))?\)/.exec(rgba); return m ? (m[1] === undefined ? 1 : parseFloat(m[1])) : NaN; };

// Same seed as board-crew-state.spec.js: one booking today, two utes, three
// crew in the three acceptance states (idempotent).
const PEOPLE = [
  { name: 'Accept Yes One', status: 'confirmed' },
  { name: 'Accept Pending One', status: 'assigned' },
  { name: 'Accept No One', status: 'declined' },
];
function seedBoard() {
  return withDb(db => {
    const today = sydneyToday();
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-ACCEPT'").get();
    if (!bk) {
      db.prepare(`INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
                  VALUES ('BK-ACCEPT', 'Acceptance board booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')`).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    } else {
      db.prepare("UPDATE bookings SET start_datetime = ? || 'T07:00', end_datetime = ? || 'T15:00' WHERE id = ?").run(today, today, bk.id);
    }
    let vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bk.id);
    if (vehicles.length < 2) {
      for (const n of ['ACC-UTE-1', 'ACC-UTE-2']) {
        db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role) VALUES (?, ?, 'ute')").run(bk.id, n);
      }
      vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bk.id);
    }
    for (const p of PEOPLE) {
      let cm = db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(p.name);
      if (!cm) {
        db.prepare('INSERT INTO crew_members (full_name, active) VALUES (?, 1)').run(p.name);
        cm = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      const existing = db.prepare('SELECT id FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bk.id, cm.id);
      if (existing) db.prepare('UPDATE booking_crew SET status = ?, assigned_vehicle_id = ?, off_vehicle = 0 WHERE id = ?').run(p.status, vehicles[0].id, existing.id);
      else db.prepare('INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id) VALUES (?, ?, ?, ?)').run(bk.id, cm.id, p.status, vehicles[0].id);
    }
  });
}
async function openBoard(page) {
  await loginAs(page);
  await page.goto('/bookings/board');
  await page.waitForLoadState('networkidle');
}
const cardFor = (page) => page.locator('.bk2-card', { hasText: 'BK-ACCEPT' }).first();

// Blurred layers that actually cost anything: on screen, painted, opaque > 0.
const countBlurred = (page) => page.evaluate(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  return [...document.querySelectorAll('*')].filter(el => {
    const s = getComputedStyle(el);
    if (!s.backdropFilter || s.backdropFilter === 'none') return false;
    if (s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }).length;
});

test('bookings chrome is glass, cards are translucent tint with no blur, banner stays opaque', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const header = page.locator('.bk2-header');
  expect(await css(header, 'backdropFilter')).toMatch(/blur\(/);
  expect(await css(header, 'position')).toBe('sticky');

  const card = cardFor(page);
  await expect(card).toHaveCount(1);
  const bg = await css(card, 'backgroundColor');
  expect(alphaOf(bg), `card should be translucent, got ${bg}`).toBeLessThan(1);
  expect(await css(card, 'backdropFilter')).toBe('none');
  expect(await css(card, 'pointerEvents', '::before')).toBe('none');
  expect(alphaOf(await css(card.locator('.bk2-card-banner'), 'backgroundColor'))).toBe(1);
});

test('phone blur budget on the board: at most four blurred layers at rest', async ({ page }) => {
  test.skip(page.viewportSize().width >= 768, 'phone budget only');
  seedBoard();
  await openBoard(page);
  expect(await countBlurred(page)).toBeLessThanOrEqual(4);
});

test('crew-slot acceptance colours survive the glass layer', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const card = cardFor(page);
  const colours = await card.locator('.bk2-slot-accept').evaluateAll(els => els.map(e => getComputedStyle(e).color));
  expect(new Set(colours).size).toBeGreaterThanOrEqual(3);
  const declined = card.locator('.bk2-slot--filled', { hasText: 'Accept No One' }).first();
  const pending = card.locator('.bk2-slot--filled', { hasText: 'Accept Pending One' }).first();
  await expect(declined).toHaveClass(/bk2-slot--st-no/);
  const [decBg, penBg] = await Promise.all([css(declined, 'backgroundColor'), css(pending, 'backgroundColor')]);
  expect(decBg).not.toBe(penBg);
});

test('the view-switcher thumb tracks the active tab, and steps aside under reduced motion', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const views = page.locator('.bk2-views[data-lg-segment]');
  await expect(views).toHaveCount(1);
  await expect(views).toHaveClass(/lg-seg-ready/);
  const thumb = views.locator('.lg-seg-thumb');
  const active = views.locator('.bk2-view-tab[aria-selected="true"]');
  const near = async () => {
    const [t, a] = await Promise.all([thumb.boundingBox(), active.boundingBox()]);
    return Math.abs(t.x - a.x) < 2 && Math.abs(t.width - a.width) < 2;
  };
  await expect.poll(near).toBe(true);
  const before = await thumb.evaluate(el => el.style.transform);
  await views.locator('[data-view-tab="list"]').click();
  await expect(views.locator('.bk2-view-tab[aria-selected="true"]')).toHaveAttribute('data-view-tab', 'list');
  await expect.poll(() => thumb.evaluate(el => el.style.transform)).not.toBe(before);
  await expect.poll(near).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.bk2-views .lg-seg-thumb')).toHaveCount(0);
  const nativeActive = page.locator('.bk2-views .bk2-view-tab[aria-selected="true"]');
  expect(alphaOf(await css(nativeActive, 'backgroundColor'))).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

// Recruitment — the tap-to-move sheet is glass and still lands on screen.
const NAME = 'LG Glass Mover';
let applicantId;
const now = new Date();
const year = now.getFullYear(), month = now.getMonth() + 1;
const listMonth = `${year}-${String(month).padStart(2, '0')}`;
test.beforeAll(() => {
  withDb(db => {
    db.prepare('DELETE FROM seek_applicants WHERE applicant_name = ?').run(NAME);
    applicantId = db.prepare(`INSERT INTO seek_applicants (applicant_name, phone, email, date_applied, list_month, stage)
                              VALUES (?, '0400 000 002', 'lg@example.com', ?, ?, 'NEW')`).run(NAME, `${listMonth}-03`, listMonth).lastInsertRowid;
  });
});
test.afterAll(() => { withDb(db => db.prepare('DELETE FROM seek_applicants WHERE applicant_name = ?').run(NAME)); });

test('recruitment columns are tint-only, cards are legible glass, and the move sheet is on-screen glass', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/induction/admin/recruitment?year=${year}&month=${month}`);
  const card = page.locator(`#card-${applicantId}`);
  await expect(card).toBeVisible();
  const col = page.locator('.rec-col[data-col-stage="NEW"]');
  expect(await css(col, 'backdropFilter')).toBe('none');
  expect(alphaOf(await css(col, 'backgroundColor'))).toBeLessThan(1);
  expect(alphaOf(await css(card, 'backgroundColor'))).toBeGreaterThan(0.6);

  await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 400; });
  await card.locator('.rec-card-move').click();
  const sheet = page.locator('.rmv-sheet.is-open');
  await expect(sheet).toBeVisible();
  expect(await css(sheet, 'backdropFilter')).toMatch(/blur\(/);
  const box = await sheet.boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vh + 1);
  await page.keyboard.press('Escape');
});
