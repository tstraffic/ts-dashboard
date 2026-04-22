// Shared helpers for Playwright tests.
//
// loginAs(page, username, password) — drives the login form and asserts
// we land on the dashboard. Every test uses this because every admin
// route requires a session.
//
// resetTestDb() — synchronously deletes the test SQLite file so the app
// re-runs migrations + seeds a fresh admin user on next boot. Called
// from globalSetup before webServer starts.

const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const TEST_DB = path.join(__dirname, '..', '..', '..', 'data', 'test-e2e.db');

function resetTestDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = TEST_DB + suffix;
    try { fs.unlinkSync(p); } catch (e) { /* not present → fine */ }
  }
}

async function loginAs(page, username = 'admin', password = 'admin123') {
  await page.goto('/login');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/dashboard$/);
}

module.exports = { loginAs, resetTestDb, TEST_DB };
