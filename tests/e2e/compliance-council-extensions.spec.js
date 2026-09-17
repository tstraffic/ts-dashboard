// Plans & Approvals — fees are editable after the fact on every sub-plan, and
// a council application that needs an extension gets its OWN sub-plan.
//
// Before: a fee could only be added or deleted (a typo meant delete + re-add,
// losing the receipt), the Fees section existed for council only, and a
// council extension was a dated chip buried on the original card. Now:
//  - POST /sub-plans/:id/fees/:feeId edits description / amount / receipt
//  - every sub-plan type carries a collapsed Fees section
//  - POST /sub-plans/:id/extension-plan creates a linked council_permit
//    sub-plan (extension_of_id → original) and flags the original; deleting
//    the extension plan clears the flag again.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// Parent plan 9902 with one lodged council application and one TGS, fresh each run.
function seedPlan() {
  return withDb(db => {
    const old = db.prepare("SELECT id FROM compliance WHERE title LIKE 'CXPLAN %' OR parent_id IN (SELECT id FROM compliance WHERE title LIKE 'CXPLAN %')").all().map(r => r.id);
    if (old.length) {
      const ph = old.map(() => '?').join(',');
      db.prepare(`DELETE FROM compliance_fees WHERE compliance_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM compliance WHERE parent_id IN (${ph})`).run(...old);
      db.prepare(`DELETE FROM compliance WHERE id IN (${ph})`).run(...old);
    }
    db.prepare("INSERT INTO compliance (parent_id, plan_number, item_type, title, status) VALUES (NULL, 9902, 'other', 'CXPLAN parent', 'not_started')").run();
    const parentId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare(`INSERT INTO compliance (parent_id, item_type, item_types, title, reference_number, description, status, submitted_date, job_date, council_plan_type)
                VALUES (?, 'council_permit', 'council_permit', 'TSCA9902', 'TSCA9902', 'Road Opening Permit', 'submitted', '2026-09-01', '2026-10-05', 'Road opening')`).run(parentId);
    const councilId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare(`INSERT INTO compliance (parent_id, item_type, item_types, title, reference_number, status)
                VALUES (?, 'traffic_guidance', 'traffic_guidance', 'TSTGS9902', 'TSTGS9902', 'not_started')`).run(parentId);
    const tgsId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    return { parentId, councilId, tgsId };
  });
}
const editUrl = (seed) => `/compliance/${seed.parentId}/edit`;
async function openCard(page, subId) {
  await page.evaluate((id) => { const el = document.getElementById('sub-' + id); if (el) el.open = true; }, subId);
}
// Direct POSTs need the page's CSRF token (same trick as compliance-plans.spec).
const csrf = (page) => page.evaluate(() => (document.querySelector('meta[name="csrf-token"]') || {}).content || '');
async function openFees(page, subId) {
  await page.evaluate((id) => { const d = document.querySelector(`details[data-fees="${id}"]`); if (d) d.open = true; }, subId);
}

let seed;

test('a council fee can be added, then edited in place — the roll-up follows', async ({ page }) => {
  seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.councilId}`);
  await openCard(page, seed.councilId);
  await openFees(page, seed.councilId);

  const add = card.locator('form[data-fee-add-form]');
  await add.locator('input[name="description"]').fill('Lodgement fee');
  await add.locator('input[name="amount"]').fill('180');
  await add.locator('button', { hasText: 'Add fee' }).click();
  await page.waitForLoadState('networkidle');

  const fee = withDb(db => db.prepare('SELECT * FROM compliance_fees WHERE compliance_id = ?').get(seed.councilId));
  expect(fee.amount).toBe(180);

  // Edit: the row has an Edit control that reveals a prefilled form.
  await openCard(page, seed.councilId);
  await openFees(page, seed.councilId);
  const row = page.locator(`[data-fee-row="${fee.id}"]`);
  await expect(row).toContainText('Lodgement fee');
  await row.locator('[data-fee-edit]').click();
  const editForm = row.locator(`form[data-fee-edit-form="${fee.id}"]`);
  await expect(editForm).toBeVisible();
  await expect(editForm.locator('input[name="amount"]')).toHaveValue('180.00');
  await editForm.locator('input[name="description"]').fill('Lodgement fee (revised)');
  await editForm.locator('input[name="amount"]').fill('275.5');
  await editForm.locator('button', { hasText: 'Save fee' }).click();
  await page.waitForLoadState('networkidle');

  const after = withDb(db => ({
    fee: db.prepare('SELECT description, amount FROM compliance_fees WHERE id = ?').get(fee.id),
    sub: db.prepare('SELECT council_fee_amount, council_fee_paid FROM compliance WHERE id = ?').get(seed.councilId),
  }));
  expect(after.fee).toEqual({ description: 'Lodgement fee (revised)', amount: 275.5 });
  expect(after.sub.council_fee_amount).toBe(275.5);
  expect(after.sub.council_fee_paid).toBe(1);
  await openCard(page, seed.councilId);
  await expect(page.locator(`[data-fee-row="${fee.id}"]`)).toContainText('Lodgement fee (revised)');
  await expect(page.locator(`[data-fee-row="${fee.id}"] [data-fee-amount]`)).toHaveText('$275.50');
});

test('a blank amount on edit keeps the current value instead of zeroing it', async ({ page }) => {
  await loginAs(page);
  const token = await csrf(page);
  const fee = withDb(db => db.prepare('SELECT id FROM compliance_fees WHERE compliance_id = ?').get(seed.councilId));
  const res = await page.request.post(`/compliance/sub-plans/${seed.councilId}/fees/${fee.id}`, {
    headers: { accept: 'application/json' },
    multipart: { _csrf: token, description: 'Lodgement fee (final)', amount: '' },
  });
  expect(res.ok()).toBe(true);
  const row = withDb(db => db.prepare('SELECT description, amount FROM compliance_fees WHERE id = ?').get(fee.id));
  expect(row).toEqual({ description: 'Lodgement fee (final)', amount: 275.5 });
});

test('every sub-plan type has a Fees section, not just council', async ({ page }) => {
  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.tgsId}`);
  await openCard(page, seed.tgsId);
  const fees = card.locator(`details[data-fees="${seed.tgsId}"]`);
  await expect(fees).toHaveCount(1);
  await expect(fees.locator('summary')).toContainText('Fees');
  await openFees(page, seed.tgsId);
  const add = fees.locator('form[data-fee-add-form]');
  await add.locator('input[name="description"]').fill('Plan printing');
  await add.locator('input[name="amount"]').fill('40');
  await add.locator('button', { hasText: 'Add fee' }).click();
  await page.waitForLoadState('networkidle');
  const row = withDb(db => db.prepare('SELECT description, amount FROM compliance_fees WHERE compliance_id = ?').get(seed.tgsId));
  expect(row).toEqual({ description: 'Plan printing', amount: 40 });
});

let extId;
test('marking a council application as extended creates a linked extension sub-plan', async ({ page }) => {
  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.councilId}`);
  await openCard(page, seed.councilId);
  await expect(card.locator('[data-extension-plans]')).toContainText('None');
  await card.locator('[data-ext-plan-toggle]').click();
  const form = card.locator('form[data-extension-plan-form]');
  await expect(form).toBeVisible();
  await form.locator('input[name="job_date"]').fill('2026-11-10');
  await form.locator('input[name="reason"]').fill('Works running two weeks over');
  await form.locator('button', { hasText: 'Create extension sub-plan' }).click();
  await page.waitForLoadState('networkidle');

  const rows = withDb(db => ({
    ext: db.prepare("SELECT * FROM compliance WHERE extension_of_id = ?").get(seed.councilId),
    orig: db.prepare('SELECT extension_required FROM compliance WHERE id = ?').get(seed.councilId),
  }));
  expect(rows.ext).toBeTruthy();
  extId = rows.ext.id;
  expect(rows.ext.item_type).toBe('council_permit');
  expect(rows.ext.parent_id).toBe(seed.parentId);
  expect(rows.ext.reference_number).toBe('TSCA9902-2');
  expect(rows.ext.description).toBe('Road Opening Permit — extension');
  expect(rows.ext.council_plan_type).toBe('Road opening');
  expect(rows.ext.job_date).toBe('2026-11-10');
  expect(rows.ext.notes).toBe('Works running two weeks over');
  expect(rows.ext.status).toBe('not_started');
  expect(rows.orig.extension_required).toBe(1);

  // Landed on the new card, which names its original; the original lists it.
  expect(page.url()).toContain(`#sub-${extId}`);
  const extCard = page.locator(`#sub-${extId}`);
  await expect(extCard).toHaveCount(1);
  await expect(extCard.locator('[data-ext-of-chip]')).toContainText('EXT of TSCA9902');
  await openCard(page, extId);
  await expect(extCard.locator('[data-extension-of]')).toContainText('TSCA9902');
  await expect(extCard.locator('[data-ext-plan-toggle]')).toHaveCount(0);   // no chains
  await openCard(page, seed.councilId);
  await expect(card.locator(`[data-ext-plan-chip="${extId}"]`)).toContainText('TSCA9902-2');
  await expect(card.locator('[data-ext-count-chip]')).toHaveText('1 ext');

  // The register flags both sides.
  await page.goto('/compliance?ref=TSCA9902');
  const exp = page.locator(`#exp-${seed.parentId}`);
  await expect(exp).toHaveCount(1);
  await expect(exp).toContainText('TSCA9902-2', { useInnerText: false });
  await expect(exp).toContainText('extended', { useInnerText: false });
  await expect(exp).toContainText('extension', { useInnerText: false });
});

test('a second extension hangs off the original, and deleting one recomputes the flag', async ({ page }) => {
  await loginAs(page);
  const token = await csrf(page);
  const res = await page.request.post(`/compliance/sub-plans/${extId}/extension-plan`, { headers: { accept: 'application/json' }, form: { _csrf: token } });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.extension_of_id).toBe(seed.councilId);   // off the ORIGINAL, not the extension
  expect(body.reference_number).toBe('TSCA9902-3');
  const second = withDb(db => db.prepare('SELECT description FROM compliance WHERE id = ?').get(body.id));
  expect(second.description).toBe('Road Opening Permit — extension 2');

  // Delete both; the original's flag follows the count.
  for (const id of [body.id, extId]) {
    const del = await page.request.post(`/compliance/sub-plans/${id}/delete`, { headers: { accept: 'application/json' }, form: { _csrf: token } });
    expect(del.ok()).toBe(true);
  }
  const orig = withDb(db => db.prepare('SELECT extension_required FROM compliance WHERE id = ?').get(seed.councilId));
  expect(orig.extension_required).toBe(0);
});

test('non-council sub-plans cannot spawn extension plans', async ({ page }) => {
  await loginAs(page);
  const token = await csrf(page);
  const res = await page.request.post(`/compliance/sub-plans/${seed.tgsId}/extension-plan`, { headers: { accept: 'application/json' }, form: { _csrf: token } });
  expect(res.status()).toBe(400);
});
