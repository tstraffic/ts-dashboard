// Public induction form: the email is typed twice and must match.
//
// The booking confirmation and every reminder go to this address, and a
// one-letter typo meant the applicant never heard from us. The form has
// novalidate and posts over fetch, so the server check is the one that counts;
// the step-2 check is what the applicant actually sees.
const { test, expect } = require('@playwright/test');

const BASE_FIELDS = {
  first_name: 'Jane', last_name: 'Doe', phone: '0400 000 000',
  date_of_birth: '1990-01-01', payment_type: 'tfn',
};
async function submit(page, fields) {
  return page.request.post('/induction/submit', {
    headers: { 'X-Requested-With': 'fetch' },
    multipart: { ...BASE_FIELDS, ...fields },
  });
}

test('the server rejects a mismatch or a malformed address before anything else', async ({ page }) => {
  let r = await submit(page, { email: 'jane.doe@example.com', confirm_email: 'jane.deo@example.com' });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/don't match/);

  r = await submit(page, { email: 'not-an-email', confirm_email: 'not-an-email' });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/valid email address/);

  // Case and surrounding spaces don't count as a mismatch…
  r = await submit(page, { email: ' Jane.Doe@Example.com ', confirm_email: 'jane.doe@example.com' });
  expect(r.status()).toBe(400);
  // …so the email gate passes and the NEXT check (signature/consent) is what stops it.
  expect((await r.json()).error).toMatch(/sign the induction agreement/);
});

test('step 2 will not advance until the two boxes match', async ({ page }) => {
  await page.goto('/induction');
  await page.evaluate(() => { document.getElementById('markAsRead').checked = true; goToStep(2); });
  await expect(page.locator('#step2')).toBeVisible();

  await page.fill('#emailInput', 'jane.doe@example.com');
  await page.fill('#confirmEmailInput', 'jane.deo@example.com');
  await page.locator('#step2 button[onclick="goToStep(3)"]').click();
  await expect(page.locator('#emailMatchError')).toBeVisible();
  await expect(page.locator('#emailMatchError')).toContainText(/don't match/);
  await expect(page.locator('#step2')).toBeVisible();
  await expect(page.locator('#confirmEmailInput')).toHaveClass(/ring-red-300/);

  // Typing again clears the message; a matching pair clears the email check
  // (other required fields still hold the step, so no red ring on the emails).
  await page.fill('#confirmEmailInput', 'jane.doe@example.com');
  await expect(page.locator('#emailMatchError')).toBeHidden();
  await page.locator('#step2 button[onclick="goToStep(3)"]').click();
  await expect(page.locator('#emailMatchError')).toBeHidden();
  await expect(page.locator('#emailInput')).not.toHaveClass(/ring-red-300/);

  // The second box refuses pasted text — it has to be typed.
  expect(await page.locator('#confirmEmailInput').getAttribute('onpaste')).toBe('return false');
});
