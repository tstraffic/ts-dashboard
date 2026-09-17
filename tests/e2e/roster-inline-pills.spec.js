// HR roster — the inline pills (payment type, status, portal role…) save.
//
// The roster table used to sit INSIDE the bulk delete/restore <form>. Nested
// forms are illegal HTML, so the browser dropped every pill's own <form>; the
// pill's change handler then found the outer form with closest('form') and
// posted "CASH → TFN" to /hr/roster/delete — a redirect, so the UI said
// "Failed to save" and reverted the pill to "—". Had rows been ticked, the
// change would have soft-deleted them. The delete form is now an empty
// sibling; checkboxes join it through form="rosterDeleteForm".
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const NAME = 'Pill Roster Tester';
let empId;
test.beforeAll(() => {
  withDb(db => {
    db.prepare('DELETE FROM employees WHERE full_name = ?').run(NAME);
    empId = db.prepare(`INSERT INTO employees (full_name, first_name, last_name, employment_status, active, payment_type)
                        VALUES (?, 'Pill', 'Roster Tester', 'active', 1, 'abn')`).run(NAME).lastInsertRowid;
  });
});
test.afterAll(() => { withDb(db => db.prepare('DELETE FROM employees WHERE full_name = ?').run(NAME)); });

test('the table is not wrapped in a form, and every pill owns its own save form', async ({ page }) => {
  await loginAs(page);
  await page.goto('/hr/roster?search=' + encodeURIComponent('Pill Roster'));
  await expect(page.locator('select[data-inline-pill="payment_type"]')).toHaveCount(1);
  const shape = await page.evaluate(() => ({
    tableInsideForm: !!document.querySelector('form table'),
    pillActions: [...document.querySelectorAll('select[data-inline-pill]')].map(s => { const f = s.closest('form'); return f ? f.getAttribute('action') : null; }),
    checkboxForm: document.querySelector('input.roster-chk') && document.querySelector('input.roster-chk').getAttribute('form'),
    deleteFormExists: !!document.getElementById('rosterDeleteForm'),
  }));
  expect(shape.tableInsideForm).toBe(false);
  expect(shape.deleteFormExists).toBe(true);
  expect(shape.checkboxForm).toBe('rosterDeleteForm');
  expect(shape.pillActions.length).toBeGreaterThan(0);
  for (const a of shape.pillActions) expect(a).toMatch(/^\/hr\/employees\/\d+\//);
});

test('changing ABN → TFN saves to the right route and sticks', async ({ page }) => {
  await loginAs(page);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto('/hr/roster?search=' + encodeURIComponent('Pill Roster'));
  const sel = page.locator('select[data-inline-pill="payment_type"]').first();
  await expect(sel).toHaveValue('abn');
  const saved = page.waitForResponse(r => r.url().includes(`/hr/employees/${empId}/payment-type`) && r.request().method() === 'POST');
  await sel.selectOption('tfn');
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ success: true, payment_type: 'tfn' });
  await expect(sel).toHaveValue('tfn');
  expect(dialogs).toEqual([]);
  expect(withDb(db => db.prepare('SELECT payment_type FROM employees WHERE id = ?').get(empId).payment_type)).toBe('tfn');
  // Nothing was deleted by the side door.
  expect(withDb(db => db.prepare('SELECT deleted_at FROM employees WHERE id = ?').get(empId).deleted_at)).toBeNull();
});

test('ticking a row still feeds the bulk delete form', async ({ page }) => {
  await loginAs(page);
  await page.goto('/hr/roster?search=' + encodeURIComponent('Pill Roster'));
  await page.locator('input.roster-chk').first().check();
  const ids = await page.evaluate(() => [...new FormData(document.getElementById('rosterDeleteForm')).getAll('ids')]);
  expect(ids).toEqual([String(empId)]);
  await expect(page.locator('#rosterBulk')).toBeVisible();
  await expect(page.locator('#rosterBulkCount')).toHaveText('1 selected');
});
