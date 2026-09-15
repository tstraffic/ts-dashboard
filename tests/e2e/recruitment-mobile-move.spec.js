// Recruitment on a phone: tapping ⇄ → "Booked" must show the induction-date
// modal ON SCREEN, and confirming must save.
//
// The modals were children of #rec-root, which carries a transform after the
// page-enter motion — so their position:fixed resolved against #rec-root, and
// once the board had been scrolled the modal opened hundreds of pixels above
// the viewport. The move then looked like it silently failed ("still stuck in
// New"). They now live under <body>, like the tap-to-move sheet always did.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const NAME = 'MM Phone Mover';
let applicantId;
const now = new Date();
const year = now.getFullYear(), month = now.getMonth() + 1;
const listMonth = `${year}-${String(month).padStart(2, '0')}`;

test.beforeAll(() => {
  withDb(db => {
    db.prepare('DELETE FROM seek_applicants WHERE applicant_name = ?').run(NAME);
    applicantId = db.prepare(`INSERT INTO seek_applicants (applicant_name, phone, email, date_applied, list_month, stage)
                              VALUES (?, '0400 000 001', 'mm@example.com', ?, ?, 'NEW')`)
      .run(NAME, `${listMonth}-03`, listMonth).lastInsertRowid;
  });
});
test.afterAll(() => { withDb(db => db.prepare('DELETE FROM seek_applicants WHERE applicant_name = ?').run(NAME)); });

test('⇄ → Booked opens the date modal inside the viewport even after scrolling, and saves', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/induction/admin/recruitment?year=${year}&month=${month}`);
  const card = page.locator(`#card-${applicantId}`);
  await expect(card).toHaveAttribute('data-stage', 'NEW');

  // Scroll the content pane down the way a thumb does before reaching a card
  // (the admin layout scrolls <main>, not the window).
  await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 600; window.scrollTo(0, 600); });

  await card.locator('.rec-card-move').click();
  const sheet = page.locator('.rmv-sheet.is-open');
  await expect(sheet).toBeVisible();
  await sheet.locator('.rmv-opt[data-stage="BOOKED"]').click();

  // The modal must be a child of <body> and fully on screen.
  const modal = page.locator('#booking-modal');
  await expect(modal).toBeVisible();
  expect(await modal.evaluate(el => el.parentElement === document.body)).toBe(true);
  const box = await modal.locator('.rec-modal-card').boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
  await expect(page.locator('#booking-confirm')).toBeInViewport();

  await page.fill('#booking-date', '2026-10-20');
  await page.fill('#booking-time', '09:00');
  await page.locator('#booking-confirm').click();

  // Toast is also re-parented, so it's on screen too.
  await expect(page.locator('#rec-toast')).toBeVisible();
  await expect(card).toHaveAttribute('data-stage', 'BOOKED');
  await expect.poll(() => withDb(db => db.prepare('SELECT stage, induction_date, induction_time FROM seek_applicants WHERE id = ?').get(applicantId)))
    .toEqual({ stage: 'BOOKED', induction_date: '2026-10-20', induction_time: '09:00' });

  // Survives a reload — it really saved.
  await page.reload();
  await expect(page.locator(`#card-${applicantId}`)).toHaveAttribute('data-stage', 'BOOKED');
});
