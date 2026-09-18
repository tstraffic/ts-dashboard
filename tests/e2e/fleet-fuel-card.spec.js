// Fleet — a fuel card (number + PIN) per vehicle, on the vehicle details page.
//
// The card lives encrypted on the vehicle row; the page only ever renders the
// last four digits. Reveal fetches the plaintext on demand and is audited;
// editing with a blank number/PIN keeps the current values; Remove clears it.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const ASSET = 'FUEL-E2E';
const NUMBER = '7018 0000 1234 4321';
const NUMBER_DIGITS = NUMBER.replace(/\s/g, '');
let vehicleId;

test.beforeAll(() => {
  withDb(db => {
    const old = db.prepare('SELECT id FROM vehicles WHERE asset_id = ?').get(ASSET);
    if (old) { db.prepare('DELETE FROM service_records WHERE vehicle_id = ?').run(old.id); db.prepare('DELETE FROM vehicles WHERE id = ?').run(old.id); }
    vehicleId = db.prepare("INSERT INTO vehicles (asset_id, fleet_id, rego, make, model, status) VALUES (?, 'FUEL01', 'FCE01L', 'Toyota', 'Hilux', 'Active')").run(ASSET).lastInsertRowid;
  });
});
test.afterAll(() => { withDb(db => { db.prepare('DELETE FROM vehicles WHERE asset_id = ?').run(ASSET); }); });

const row = () => withDb(db => db.prepare('SELECT fuel_card_provider, fuel_card_last4, fuel_card_number_enc, fuel_card_pin_enc FROM vehicles WHERE id = ?').get(vehicleId));

test('saving a fuel card stores it encrypted and shows only the last four digits', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/fleet/${vehicleId}`);
  const card = page.locator('#fuelCard');
  await expect(card).toContainText('No fuel card on file');
  const form = card.locator('form[data-fuel-form]');
  await form.locator('input[name="fuel_card_provider"]').fill('Shell Card');
  await form.locator('input[name="fuel_card_number"]').fill(NUMBER);
  await form.locator('input[name="fuel_card_pin"]').fill('4321');
  await form.locator('button[type="submit"]', { hasText: 'Save fuel card' }).click();
  await page.waitForLoadState('networkidle');

  const r = row();
  expect(r.fuel_card_provider).toBe('Shell Card');
  expect(r.fuel_card_last4).toBe('4321');
  expect(r.fuel_card_number_enc).toBeTruthy();
  expect(r.fuel_card_number_enc).not.toContain(NUMBER_DIGITS);
  expect(r.fuel_card_number_enc).not.toContain('70180000');
  expect(r.fuel_card_pin_enc).toBeTruthy();
  expect(r.fuel_card_pin_enc).not.toBe('4321');

  await expect(card.locator('[data-fuel-number]')).toHaveText('•••• •••• •••• 4321');
  await expect(card.locator('[data-fuel-pin]')).toHaveText('••••');
  await expect(card).toContainText('Shell Card');
  // The plaintext must not be anywhere in the page.
  const html = await page.content();
  expect(html).not.toContain('70180000');
  expect(html).not.toContain(NUMBER);
  expect(html).not.toMatch(/value="4321"/);
});

test('Reveal fetches the plaintext on demand, re-masks on Hide, and is audited', async ({ page }) => {
  await loginAs(page);
  const before = withDb(db => db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE entity_type = 'vehicle' AND entity_id = ? AND action = 'download'").get(vehicleId).c);
  await page.goto(`/fleet/${vehicleId}`);
  const card = page.locator('#fuelCard');
  await card.locator('[data-fuel-reveal]').click();
  await expect(card.locator('[data-fuel-number]')).toHaveText('7018 0000 1234 4321');
  await expect(card.locator('[data-fuel-pin]')).toHaveText('4321');
  await expect(card.locator('[data-fuel-reveal]')).toHaveText('Hide');
  await card.locator('[data-fuel-reveal]').click();
  await expect(card.locator('[data-fuel-number]')).toHaveText('•••• •••• •••• 4321');
  await expect(card.locator('[data-fuel-pin]')).toHaveText('••••');
  const after = withDb(db => db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE entity_type = 'vehicle' AND entity_id = ? AND action = 'download'").get(vehicleId).c);
  expect(after).toBe(before + 1);

  // The endpoint itself answers JSON with no-store caching.
  const res = await page.request.get(`/fleet/${vehicleId}/fuel-card/reveal`, { headers: { accept: 'application/json' } });
  expect(res.ok()).toBe(true);
  expect(res.headers()['cache-control']).toContain('no-store');
  expect(await res.json()).toEqual({ ok: true, provider: 'Shell Card', number: NUMBER_DIGITS, pin: '4321' });
});

test('editing only the provider keeps the number and PIN', async ({ page }) => {
  await loginAs(page);
  const beforeRow = row();
  await page.goto(`/fleet/${vehicleId}`);
  const card = page.locator('#fuelCard');
  await card.locator('[data-fuel-edit-toggle]').click();
  const form = card.locator('form[data-fuel-form]');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="fuel_card_number"]')).toHaveAttribute('placeholder', /keep •••• 4321/);
  await form.locator('input[name="fuel_card_provider"]').fill('BP Plus');
  await form.locator('button[type="submit"]', { hasText: 'Save changes' }).click();
  await page.waitForLoadState('networkidle');
  const r = row();
  expect(r.fuel_card_provider).toBe('BP Plus');
  expect(r.fuel_card_last4).toBe('4321');
  expect(r.fuel_card_number_enc).toBe(beforeRow.fuel_card_number_enc);
  expect(r.fuel_card_pin_enc).toBe(beforeRow.fuel_card_pin_enc);
});

test('a bad number is refused and nothing changes', async ({ page }) => {
  await loginAs(page);
  const beforeRow = row();
  const token = await page.evaluate(() => (document.querySelector('meta[name="csrf-token"]') || {}).content || '');
  const res = await page.request.post(`/fleet/${vehicleId}/fuel-card`, { headers: { accept: 'application/json' }, form: { _csrf: token, fuel_card_number: '12', fuel_card_pin: '9999' } });
  expect(res.status()).toBe(400);
  expect(row()).toEqual(beforeRow);
  const res2 = await page.request.post(`/fleet/${vehicleId}/fuel-card`, { headers: { accept: 'application/json' }, form: { _csrf: token, fuel_card_pin: '12' } });
  expect(res2.status()).toBe(400);
  expect(row()).toEqual(beforeRow);
});

test('Remove card clears everything', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/fleet/${vehicleId}`);
  const card = page.locator('#fuelCard');
  await card.locator('[data-fuel-edit-toggle]').click();
  page.once('dialog', d => d.accept());
  await card.locator('form[data-fuel-form] button[value="clear"]').click();
  await page.waitForLoadState('networkidle');
  const r = row();
  expect(r.fuel_card_number_enc).toBeNull();
  expect(r.fuel_card_pin_enc).toBeNull();
  expect(r.fuel_card_last4).toBe('');
  await expect(page.locator('#fuelCard')).toContainText('No fuel card on file');
});
