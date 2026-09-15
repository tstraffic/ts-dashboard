// Liquid Glass — the shell material (public/css/liquid-glass.css).
//
// Pins the promises the design makes, not the exact colours:
//  - the header and top-level cards are real glass (backdrop blur) in BOTH
//    themes; the default light `ts` theme used to switch glass off entirely
//  - an ambient field sits behind everything, out of the way of hit-testing
//  - the sidebar contract survives (66 links, the literal bg-white/15 token)
//  - reduced motion stops the ambient drift; print goes back to opaque white
//  - phones keep blur for chrome only (in-flow cards go tint-only)
//  - the fallbacks Playwright can't emulate (prefers-reduced-transparency,
//    @supports not backdrop-filter) are at least present in the file
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

const css = (loc, prop, pseudo) => loc.evaluate((el, [p, ps]) => getComputedStyle(el, ps || null)[p], [prop, pseudo]);
const alphaOf = (rgba) => { const m = /rgba?\(\s*\d+,\s*\d+,\s*\d+(?:,\s*([\d.]+))?\)/.exec(rgba); return m ? (m[1] === undefined ? 1 : parseFloat(m[1])) : NaN; };

async function withTheme(page, theme) {
  await page.addInitScript(t => { try { localStorage.setItem('atomis-theme', t); } catch (e) {} }, theme);
}

for (const [theme, mode] of [['ts', 'light'], ['ts-dark', 'dark']]) {
  test(`header and top-level cards are glass in ${theme}`, async ({ page }) => {
    await withTheme(page, theme);
    await loginAs(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

    const header = page.locator('#app-header');
    expect(await css(header, 'backdropFilter')).toMatch(/blur\(/);
    expect(await css(header, 'position')).toBe('sticky');
    expect(parseFloat(await css(header, 'borderTopLeftRadius'))).toBeGreaterThanOrEqual(12);

    const sidebar = page.locator('#sidebar');
    if (await sidebar.isVisible()) {
      expect(await css(sidebar, 'backdropFilter')).toMatch(/blur\(/);
      expect(alphaOf(await css(sidebar, 'backgroundColor'))).toBeLessThan(1);
    }

    // Band 1 is always rendered (dashboard.spec pins that).
    const card = page.locator('#needs-you-now');
    await expect(card).toBeVisible();
    const bg = await css(card, 'backgroundColor');
    expect(alphaOf(bg), `card must be translucent, got ${bg}`).toBeLessThan(1);
    expect(alphaOf(bg)).toBeGreaterThan(0.4);
    const narrow = page.viewportSize().width < 768;
    if (narrow) {
      // Phone budget: in-flow cards are tint-only, chrome keeps its blur.
      expect(await css(card, 'backdropFilter')).toBe('none');
    } else {
      expect(await css(card, 'backdropFilter')).toMatch(/blur\(/);
    }
    // The rim pseudo must never intercept a click.
    expect(await css(card, 'pointerEvents', '::before')).toBe('none');
  });
}

test('the ambient field is fixed, behind content and inert', async ({ page }) => {
  await loginAs(page);
  const amb = page.locator('#lg-ambient');
  await expect(amb).toHaveCount(1);
  expect(await css(amb, 'position')).toBe('fixed');
  expect(await css(amb, 'zIndex')).toBe('-1');
  expect(await css(amb, 'pointerEvents')).toBe('none');
  // It's the first body child and carries no text (dashboard body-text regexes).
  expect(await page.evaluate(() => document.body.firstElementChild && document.body.firstElementChild.id)).toBe('lg-ambient');
  expect((await amb.innerText()).trim()).toBe('');
});

test('sidebar contract: 66 links and the literal active token', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/finance');
  await expect(page.locator('#sidebar a.sidebar-link')).toHaveCount(66);
  const head = page.locator('#sidebar a.sb-section-head[href="/departments/finance"]');
  await expect(head).toHaveClass(/bg-white\/15/);
  if (await head.isVisible()) {
    // The pill is CSS-only: a brand tint on the same element.
    expect(alphaOf(await css(head, 'backgroundColor'))).toBeLessThan(1);
  }
});

test('reduced motion stops the ambient drift', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loginAs(page);
  const amb = page.locator('#lg-ambient');
  expect(await css(amb, 'animationName', '::before')).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  expect(await css(amb, 'animationName', '::before')).toBe('lg-drift-a');
});

test('print falls back to opaque white with no blur and no ambient', async ({ page }) => {
  await loginAs(page);
  await page.emulateMedia({ media: 'print' });
  const card = page.locator('#needs-you-now');
  expect(await css(card, 'backgroundColor')).toBe('rgb(255, 255, 255)');
  expect(await css(card, 'backdropFilter')).toBe('none');
  expect(await css(page.locator('#lg-ambient'), 'display')).toBe('none');
  await page.emulateMedia({ media: 'screen' });
});

test('the FAB is a brand capsule and its menu items stay tint-only', async ({ page }) => {
  await loginAs(page);
  const toggle = page.locator('#globalFabToggle');
  await expect(toggle).toBeVisible();
  expect(await toggle.getAttribute('style')).toBeNull();
  expect(await css(toggle, 'borderTopLeftRadius')).toBe('999px');
  expect(await css(toggle, 'backgroundImage')).toMatch(/linear-gradient/);
  await toggle.click();
  await expect(page.locator('#globalFabMenu')).toBeVisible();
  await expect(page.locator('#globalFab')).toHaveClass(/is-open/);
  expect(await css(page.locator('#globalFabMenu .fab-item').first(), 'backdropFilter')).toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.locator('#globalFabMenu')).toBeHidden();
});

test('the dashboard loads with no page errors under the glass layer', async ({ page }) => {
  const errors = [];
  // A Tailwind CDN load failure ("tailwind is not defined") is a network
  // event, not a bug in our scripts — every page depends on that CDN.
  page.on('pageerror', e => { if (!/tailwind/i.test(e.message)) errors.push(e.message); });
  await loginAs(page);
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
});

test('the stylesheet carries the fallbacks Playwright cannot emulate', async ({ page }) => {
  const res = await page.request.get('/css/liquid-glass.css');
  expect(res.ok()).toBe(true);
  const text = await res.text();
  expect(text).toContain('prefers-reduced-transparency');
  expect(text).toContain('@supports not ((backdrop-filter');
  expect(text).toContain('@media print');
  // Safari needs the prefixed property wherever the standard one appears.
  expect((text.match(/-webkit-backdrop-filter/g) || []).length).toBeGreaterThan(20);
});
