// Meetings: a to-do never waits for a discussion item.
//
// The "To-dos" card sits ABOVE the discussion items on a company meeting, and
// it is the only to-do surface on a client meeting — where the whole to-do UI
// used to be hidden even though the exported PDF prints them as action items.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const COMPANY = 'MTD company meeting';
const CLIENT = 'MTD client meeting';

function seedMeeting(title, type) {
  return withDb(db => {
    db.prepare('DELETE FROM company_meetings WHERE title = ?').run(title);
    return db.prepare(`
      INSERT INTO company_meetings (title, meeting_date, meeting_time, attendees, status, meeting_type)
      VALUES (?, '2026-09-15', '09:00', 'Suhail, Saadat', 'scheduled', ?)
    `).run(title, type).lastInsertRowid;
  });
}
const todosOf = (id) => withDb(db => db.prepare('SELECT * FROM company_meeting_todos WHERE meeting_id = ? ORDER BY id').all(id));

let companyId, clientId;

test.beforeAll(() => {
  companyId = seedMeeting(COMPANY, 'company');
  clientId = seedMeeting(CLIENT, 'client');
});

test.afterAll(() => {
  withDb(db => db.prepare('DELETE FROM company_meetings WHERE title IN (?, ?)').run(COMPANY, CLIENT));
});

test('a company meeting takes a to-do before any discussion item exists', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/meetings/${companyId}`);

  const todos = page.locator('#general-todos');
  await expect(todos).toBeVisible();
  await expect(todos).toContainText('To-dos');
  await expect(todos).toContainText('no discussion item needed');
  await expect(page.locator('#add-item')).toBeVisible();           // no items yet…
  await expect(page.locator('.scroll-mt-20#item-1')).toHaveCount(0);

  // …and the to-do card is offered first, not after the discussion items.
  const todosFirst = await page.evaluate(() => {
    const t = document.getElementById('general-todos'), a = document.getElementById('add-item');
    return !!(t.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(todosFirst).toBe(true);

  await todos.locator('input[name="text"]').fill('Order the new signage');
  await todos.locator('select[name="priority"]').selectOption('high');
  await todos.locator('button[type="submit"]').click();
  await page.waitForURL(/#general-todos$/);

  await expect(page.locator('#general-todos')).toContainText('Order the new signage');
  const rows = todosOf(companyId);
  expect(rows).toHaveLength(1);
  expect(rows[0].item_id).toBeNull();                              // stands on its own
  expect(rows[0].priority).toBe('high');
});

test('a client meeting has the same to-do card, and its PDF still exports', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/meetings/${clientId}`);

  const todos = page.locator('#general-todos');
  await expect(todos).toBeVisible();
  await expect(todos).toContainText('Action items');
  await expect(page.locator('#add-item')).toHaveCount(0);          // dept machinery stays hidden

  await todos.locator('input[name="text"]').fill('Send the client the TGS pack');
  await todos.locator('button[type="submit"]').click();
  await page.waitForURL(/#general-todos$/);

  await expect(page.locator('#general-todos')).toContainText('Send the client the TGS pack');
  const rows = todosOf(clientId);
  expect(rows).toHaveLength(1);
  expect(rows[0].item_id).toBeNull();

  const pdf = await page.request.get(`/meetings/${clientId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
});

test('attaching a to-do to a discussion item still works alongside it', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/meetings/${companyId}`);

  await page.locator('#add-item textarea[name="body"]').fill('Reviewed the night-shift roster');
  await page.locator('#add-item button[type="submit"]').click();
  await page.waitForURL(new RegExp(`/meetings/${companyId}`));

  const itemId = withDb(db => db.prepare('SELECT id FROM company_meeting_items WHERE meeting_id = ?').get(companyId)).id;
  const item = page.locator(`#item-${itemId}`);
  await expect(item).toBeVisible();
  await item.locator('form[action$="/todos"] input[name="text"]').fill('Confirm night crew');
  await item.locator('form[action$="/todos"] button[type="submit"]').click();
  await page.waitForURL(new RegExp(`#item-${itemId}$`));

  await expect(page.locator(`#item-${itemId}`)).toContainText('Confirm night crew');
  const rows = todosOf(companyId);
  expect(rows).toHaveLength(2);
  expect(rows.find(r => r.text === 'Confirm night crew').item_id).toBe(itemId);
  expect(rows.find(r => r.text === 'Order the new signage').item_id).toBeNull();
  // The standalone one stays in its own card, above the items.
  await expect(page.locator('#general-todos')).toContainText('Order the new signage');
  await expect(page.locator('#general-todos')).not.toContainText('Confirm night crew');
});
