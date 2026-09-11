// Hiring → Recruitment: applicants live on a monthly list, and the office can
// bring the ones it never got to forward onto a later month ("I didn't get to
// call everyone in August, so I move them to September").
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const BASE = '/induction/admin/recruitment';
const sept = `${BASE}?year=2026&month=9`;
const aug = `${BASE}?year=2026&month=8`;

test.beforeAll(() => {
  withDb(db => {
    db.prepare("DELETE FROM seek_applicants WHERE applicant_name LIKE 'CO-%'").run();
    const ins = db.prepare(`INSERT INTO seek_applicants (applicant_name, phone, date_applied, list_month, stage, date_called)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    ins.run('CO-Uncalled Aug', '0400 000 001', '2026-08-05', '2026-08', 'NEW', null);       // never called → pre-ticked
    ins.run('CO-Called Aug', '0400 000 002', '2026-08-12', '2026-08', 'CALLED', '2026-08-13'); // called → listed, unticked
    ins.run('CO-Hired Aug', '0400 000 003', '2026-08-20', '2026-08', 'HIRED', '2026-08-21');  // done → not offered
    ins.run('CO-Sept native', '0400 000 004', '2026-09-02', '2026-09', 'NEW', null);
  });
});

const idOf = (name) => withDb(db => db.prepare('SELECT id FROM seek_applicants WHERE applicant_name = ?').get(name)).id;

test('the bring-forward panel lists last month\'s open applicants, uncalled ones pre-ticked', async ({ page }) => {
  await loginAs(page);
  await page.goto(sept);
  await expect(page.locator('body')).toContainText('CO-Sept native');
  await expect(page.locator('body')).not.toContainText('CO-Uncalled Aug');

  // Pick the source month.
  await page.selectOption('select[name="from"]', '2026-08');
  await page.waitForURL(/from=2026-08/);
  const panel = page.locator('[data-bring-forward]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('August 2026');
  await expect(panel).toContainText('September 2026');
  await expect(panel.locator('[data-bf-row]')).toHaveCount(2);              // hired one isn't offered
  await expect(panel).toContainText('1 already hired, inducted or closed');
  await expect(panel.locator(`[data-bf-row="${idOf('CO-Uncalled Aug')}"] input[type="checkbox"]`)).toBeChecked();
  await expect(panel.locator(`[data-bf-row="${idOf('CO-Called Aug')}"] input[type="checkbox"]`)).not.toBeChecked();
  await expect(panel.locator('[data-bf-submit]')).toContainText(/Move 1 to September/);
});

test('moving them puts them on September\'s list with a badge, keeps the applied date, and leaves August', async ({ page }) => {
  await loginAs(page);
  await page.goto(`${sept}&from=2026-08`);
  const panel = page.locator('[data-bring-forward]');
  await panel.locator('[data-bf-submit]').click();
  await page.waitForURL(/year=2026&month=9(?!.*from=)/);
  await expect(page.locator('body')).toContainText(/Moved 1 applicant from August 2026 to September 2026/);

  const row = withDb(db => db.prepare("SELECT list_month, moved_from_month, date_applied FROM seek_applicants WHERE applicant_name = 'CO-Uncalled Aug'").get());
  expect(row.list_month).toBe('2026-09');
  expect(row.moved_from_month).toBe('2026-08');
  expect(row.date_applied).toBe('2026-08-05');                              // the real application date is untouched

  // On September's list, badged; still shows its August applied date. The
  // list view is the durable check (the board hides nothing).
  await page.locator('#view-list-btn').click();
  const lrow = page.locator(`#lrow-${idOf('CO-Uncalled Aug')}`);
  await expect(lrow).toBeVisible();
  await expect(lrow.locator('[data-moved-from="2026-08"]')).toContainText('From Aug');
  await expect(lrow).toContainText('5 Aug');

  // Gone from August; the called one stayed.
  await page.goto(aug);
  await expect(page.locator('body')).not.toContainText('CO-Uncalled Aug');
  await expect(page.locator('body')).toContainText('CO-Called Aug');

  // The CSV follows the list, and names where they came from.
  const csv = await page.request.get(`${BASE}/export.csv?year=2026&month=9`);
  const text = await csv.text();
  expect(text).toContain('CO-Uncalled Aug');
  expect(text).toContain('August 2026');
  expect(text).not.toContain('CO-Called Aug');
});

test('moving them back home clears the badge; a new applicant lands on the month being viewed', async ({ page }) => {
  await loginAs(page);
  await page.goto(`${aug}&from=2026-09`);
  const panel = page.locator('[data-bring-forward]');
  const id = idOf('CO-Uncalled Aug');
  await panel.locator(`[data-bf-row="${id}"] input[type="checkbox"]`).check();
  await panel.locator(`[data-bf-row="${idOf('CO-Sept native')}"] input[type="checkbox"]`).uncheck();
  await panel.locator('[data-bf-submit]').click();
  await page.waitForURL(/year=2026&month=8(?!.*from=)/);
  const row = withDb(db => db.prepare('SELECT list_month, moved_from_month FROM seek_applicants WHERE id = ?').get(id));
  expect(row.list_month).toBe('2026-08');
  expect(row.moved_from_month).toBeNull();

  // Add someone while looking at September with an August applied date →
  // they go on September's list (that's the list being worked).
  await page.goto(sept);
  await page.locator('button', { hasText: 'Add applicant' }).first().click();
  await page.fill('#add-applicant-row input[name="applicant_name"]', 'CO-Added while on Sept');
  await page.fill('#add-applicant-row input[name="date_applied"]', '2026-08-28');
  await page.locator('#add-applicant-row button[type="submit"]').click();
  await page.waitForURL(/year=2026&month=9/);
  const added = withDb(db => db.prepare("SELECT list_month, date_applied FROM seek_applicants WHERE applicant_name = 'CO-Added while on Sept'").get());
  expect(added.list_month).toBe('2026-09');
  expect(added.date_applied).toBe('2026-08-28');

  withDb(db => db.prepare("DELETE FROM seek_applicants WHERE applicant_name LIKE 'CO-%'").run());
});
