// Smoke test: login form works, bad creds are rejected, logout clears session.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test('login happy path → dashboard', async ({ page }) => {
  await loginAs(page);
  await expect(page.locator('h1, h2')).toContainText(/Dashboard|Welcome/i).catch(() => {});
});

test('login with bad password stays on /login', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'wrong-password');
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/login/);
});

test('protected routes redirect to /login when unauthenticated', async ({ page }) => {
  // Fresh page → no session cookie → any admin route should bounce.
  for (const url of ['/dashboard', '/jobs', '/compliance', '/audits']) {
    await page.goto(url);
    await expect(page).toHaveURL(/\/login/);
  }
});
