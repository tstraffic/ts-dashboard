// Adding an employee (Roster → Add employee → POST /hr/employees).
//
// Regression guard: the INSERT listed 53 columns but only 52 values — the
// hardcoded 1 for `active` sat one slot early, on internal_notes — so the
// statement failed to prepare and every submit 500'd with
// "52 values for 53 columns". A statement that can't prepare fails on the
// first save, so simply completing this form is the test.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

test('creating an employee from the form saves and lands on their page', async ({ page }, testInfo) => {
  await loginAs(page);
  // Unique per browser project — both run against the same DB.
  const last = `Probe${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;

  await page.goto('/hr/employees/new');
  await page.fill('input[name="first_name"]', 'Filter');
  await page.fill('input[name="last_name"]', last);

  // internal_notes lives on a LATER wizard panel (hidden until its step),
  // so fill it during the walk-through, not up front — filling a
  // display:none field times out. Only the FIRST copy matters: the other
  // submits empty, and the route must keep the filled one (and must not
  // pass the pair through as an array, which expands into extra bind
  // values and 500s the request).
  const notes = page.locator('textarea[name="internal_notes"]').first();
  let notesFilled = false;

  // Six-step wizard — the submit button only appears on the last panel.
  const submit = page.locator('button[type="submit"]:has-text("Add Employee")');
  const next = page.locator('#wizard-next');
  for (let i = 0; i < 8; i++) {
    if (!notesFilled && await notes.isVisible()) {
      await notes.fill('Created by the e2e regression test.');
      notesFilled = true;
    }
    if (await submit.isVisible()) break;
    if (!(await next.isVisible())) break; // Next hides on the final panel
    await next.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();

  // A 500 would leave us on an error page; success redirects to the record.
  await expect(page).toHaveURL(/\/hr\/employees\/\d+/);
  await expect(page.locator('body')).toContainText(`Filter ${last}`);
  await expect(page.locator('body')).not.toContainText('Server error');
});

test('enabling portal access creates a linked crew profile', async ({ page }, testInfo) => {
  await loginAs(page);
  const last = `Probe${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;

  // Open the employee created above and turn on portal access. The crew row
  // this creates has a CHECK-constrained `role`, while the employee carries
  // free text ("Traffic Controller") — the old code passed that straight
  // through and every attempt died on the constraint.
  await page.goto('/hr/employees');
  await page.locator(`a:has-text("Filter ${last}")`).first().click();
  await expect(page).toHaveURL(/\/hr\/employees\/\d+/);

  const enable = page.locator('form[action*="enable-portal"] button');
  if (await enable.count()) {
    await enable.first().click();
    await expect(page.locator('body')).toContainText('Portal access enabled');
    await expect(page.locator('body')).not.toContainText('Server error');
    // A crew profile is now linked to the employee.
    await expect(page.locator('body')).toContainText('CREW PROFILE');
  }
});
