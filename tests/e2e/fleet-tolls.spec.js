// Vehicles → Toll Invoices: upload the quarterly E-Toll statement, review the
// per-tag / per-plate sections against the register, add the trips to the
// vehicles, and reconcile a plate the register didn't know yet.
//
// The fixture PDF is generated with pdfkit at the SAME x positions the real
// NSW E-Toll statement uses (date@43, time@91, road@134, class@411, amount
// right-aligned ~546), because the parser reads columns by position. It also
// carries the two layout traps seen on genuine statements: a section that
// continues onto the next page, and the rotated document id printed down
// the right margin on a row's baseline.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PDFDocument = require('pdfkit');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { parseTollInvoice, TollParseError } = require('../../services/tollInvoiceParser');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const INVOICE_NO = '100099000001';
let fixturePdf;
let invoiceId;

function writeTollPdf(opts = {}) {
  const { invoiceNo = INVOICE_NO, periodStyle = 'long', periodLong = '03 Mar 2026 - 02 Jun 2026', periodNumeric = '03/03/2026 - 02/06/2026', name = 'etoll-fixture.pdf' } = opts;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toll-e2e-'));
  const out = path.join(dir, name);
  const doc = new PDFDocument({ size: 'A4', margin: 20 });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);
  doc.font('Helvetica').fontSize(8);
  const T = (s, x, y) => doc.text(s, x, y, { lineBreak: false });
  const row = (y, toks) => toks.forEach(([s, x]) => T(s, x, y));
  const header = (y) => row(y, [['Date', 43], ['Time', 91], ['Start - Finish', 134], ['Vehicle Class', 411], ['Amount $', 525]]);

  // Page 1 — account summary
  T('Statement/Tax Invoice', 43, 60);
  T('Account No', 300, 100); T('182905109', 300, 112);
  T('Issue Date', 300, 130); T('05 Jun 2026', 300, 142);
  if (periodStyle !== 'none') { T('Statement Period', 300, 160); T(periodStyle === 'numeric' ? periodNumeric : periodLong, 300, 172); }
  T('Invoice No', 300, 190); T(invoiceNo, 300, 202);
  row(230, [['02/06/2026', 43], ['Total toll charges', 91], ['-$1,330.62', 525]]);
  row(242, [['02/06/2026', 43], ['Total fees, charges & adjustments', 91], ['$3.30', 525]]);
  T('Includes GST** of -$120.96', 43, 260);
  T('Page 1 of 4', 510, 800);

  // Page 2 — summary table (CF94HW appears twice, tag 99990001 has no trips)
  doc.addPage();
  T('Summary use of toll charges for this period', 43, 60);
  row(80, [['Tag', 43], ['Reference', 99], ['LPN', 185], ['State', 278], ['Total Trips', 335], ['Total Tolls $', 401], ['Total Fees $', 459], ['___TOTAL $', 515]]);
  row(95, [['5019441', 43], ['TSTC006', 99], ['2', 335], ['15.74', 424], ['0', 500], ['15.74', 537]]);
  row(107, [['11793374', 43], ['1', 335], ['5.25', 428], ['0', 500], ['5.25', 542]]);
  row(119, [['11701360', 43], ['TSTC003', 99], ['1', 335], ['8.80', 428], ['0', 500], ['8.80', 542]]);
  row(131, [['55550001', 43], ['Rogue', 99], ['1', 335], ['6.06', 428], ['0', 500], ['6.06', 542]]);
  row(143, [['99990001', 43], ['0', 335], ['0', 444], ['0', 500], ['0', 557]]);
  row(155, [['CF94HW', 185], ['NSW', 278], ['1', 335], ['5.83', 428], ['2.20', 489], ['8.03', 542]]);
  row(167, [['CF94HW', 185], ['NSW', 278], ['1', 335], ['1297.50', 424], ['0', 500], ['1297.50', 537]]);
  row(179, [['ZZZ99Z', 185], ['NSW', 278], ['1', 335], ['4.41', 428], ['0.55', 489], ['4.96', 542]]);
  T('Payments, account fees and adjustments', 43, 210);
  row(225, [['Date', 43], ['Description', 91], ['Amount $', 525]]);
  row(237, [['02/06/2026', 43], ['Pre-Paid Account Top-up', 91], ['90.00', 527]]);
  T('Page 2 of 4', 510, 800);

  // Page 3 — detailed statement: three tags, then the plate that continues
  doc.addPage();
  T('Detailed statement', 43, 60);
  row(80, [['Tag Number: 5019441', 43], ['Total Trips: 2', 510]]);
  header(95);
  row(110, [['01/06/2026', 43], ['12:22', 91], ['The Hills Motorway Limited (112) -- M2 Westbound from NorthConnex', 134], ['5.25', 546]]);
  row(122, [['27/05/2026', 43], ['18:41', 91], ['WestConnex (140) -- Rozelle - James Ruse Dr', 134], ['10.49', 542]]);
  row(134, [['Total for Tag', 43], ['15.74', 537]]);
  row(160, [['Tag Number: 11793374', 43], ['Total Trips: 1', 510]]);
  header(175);
  row(190, [['25/05/2026', 43], ['05:31', 91], ['NorthConnex Company Pty Ltd (113) -- NorthConnex - Northbound', 134], ['5.25', 546]]);
  row(202, [['Total for Tag', 43], ['5.25', 542]]);
  row(228, [['Tag Number: 11701360', 43], ['Total Trips: 1', 510]]);
  header(243);
  row(258, [['21/05/2026', 43], ['15:25', 91], ['WestConnex (140) -- Rozelle - Homebush Bay Dr', 134], ['8.80', 546]]);
  row(270, [['Total for Tag', 43], ['8.80', 542]]);
  row(296, [['Tag Number: 55550001', 43], ['Total Trips: 1', 510]]);
  header(311);
  row(326, [['30/04/2026', 43], ['06:10', 91], ['M5 SOUTH WEST MOTORWAY (105) -- Hammondville (Main)', 134], ['6.06', 546]]);
  row(338, [['Total for Tag', 43], ['6.06', 542]]);
  row(364, [['Licence Plate No: CF94HW', 43], ['Total Trips: 2', 510]]);
  header(379);
  // The rotated margin id shares this row's baseline — must not eat the amount.
  row(394, [['10/05/2026', 43], ['10:57', 91], ['Transurban Interlink Roads Pty Ltd (105) -- Hammondville (Main)', 134], ['Car', 411], ['5.83', 546], ['664ROPO_1_Email_TEST/030718/037666', 581]]);
  row(406, [['10/05/2026', 43], ['10:57', 91], ['Transurban Interlink Roads Pty Ltd (105) -- Toll Notice 2 Fee', 134], ['Car', 411], ['2.20', 546]]);
  T('Page 3 of 4', 510, 800);

  // Page 4 — CF94HW continues (wrapped description + comma amount), then ZZZ99Z
  doc.addPage();
  T('Detailed statement', 43, 60);
  row(80, [['Licence Plate No: CF94HW - continued', 43], ['Total Trips: 2', 510]]);
  header(95);
  row(110, [['03/05/2026', 43], ['08:15', 91], ['Transurban Interlink Roads Pty Ltd (105) -- Cowpasture Rd to M5', 134], ['Car', 411], ['1,297.50', 533]]);
  row(122, [['Motorway (long road name continued)', 134]]);
  row(134, [['Total for Vehicle', 43], ['1305.53', 533]]);
  row(160, [['Licence Plate No: ZZZ99Z', 43], ['Total Trips: 1', 510]]);
  header(175);
  row(190, [['02/06/2026', 43], ['07:41', 91], ['M5 SOUTH WEST MOTORWAY (105) -- Hammondville (Main)', 134], ['Car', 411], ['4.41', 546]]);
  row(202, [['02/06/2026', 43], ['07:41', 91], ['M5 SOUTH WEST MOTORWAY (105) -- Video Matching Fee', 134], ['Car', 411], ['0.55', 546]]);
  row(214, [['Total for Vehicle', 43], ['4.96', 542]]);
  T('Page 4 of 4', 510, 800);

  doc.end();
  return new Promise((resolve, reject) => { stream.on('finish', () => resolve(out)); stream.on('error', reject); });
}

// Not an E-Toll statement — one text run, no Invoice No.
const MINI_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (LICENCE NO 98765) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Size 6/Root 1 0 R>>\n%%EOF'
);

const vehicleId = (assetId) => withDb(db => db.prepare('SELECT id FROM vehicles WHERE asset_id = ?').get(assetId)).id;
const tripCount = () => withDb(db => db.prepare('SELECT COUNT(*) AS n FROM toll_trips').get().n);

test.beforeAll(async () => {
  fixturePdf = await writeTollPdf();
  withDb(db => {
    db.prepare('DELETE FROM toll_trips').run();
    db.prepare('DELETE FROM toll_invoices').run();
    db.prepare("DELETE FROM vehicles WHERE asset_id = 'E2E-ZZZ'").run();
    db.prepare("UPDATE vehicles SET toll_tag = '' WHERE asset_id = 'HILUX R1'").run();
  });
});

test('the parser reads the statement layout: sections, continuation, wrap, fees, comma amounts', async () => {
  const r = await parseTollInvoice(fixturePdf);
  expect(r.invoice.number).toBe(INVOICE_NO);
  expect(r.invoice.periodStart).toBe('2026-03-03');
  expect(r.invoice.periodEnd).toBe('2026-06-02');
  expect(r.invoice.issueDate).toBe('2026-06-05');
  expect(r.invoice.totalCharges).toBe(1330.62);
  expect(r.sections.map(s => s.key)).toEqual(['tag:5019441', 'tag:11793374', 'tag:11701360', 'tag:55550001', 'plate:CF94HW', 'plate:ZZZ99Z']);

  const cf = r.sections.find(s => s.key === 'plate:CF94HW');
  expect(cf.rows).toHaveLength(3);                       // "- continued" merged into one section
  expect(cf.rows[0].amount).toBe(5.83);                  // margin id on the baseline didn't eat the amount
  expect(cf.rows[1].isFee).toBe(true);
  expect(cf.rows[2].amount).toBe(1297.5);                // comma amount
  expect(cf.rows[2].description).toContain('Motorway (long road name continued)'); // wrapped line joined
  expect(cf.trips).toBe(2); expect(cf.tolls).toBe(1303.33); expect(cf.fees).toBe(2.2); expect(cf.total).toBe(1305.53);
  expect(cf.sumMatches).toBe(true);
  expect(r.sections.every(s => s.sumMatches === true)).toBe(true);

  const tag = r.sections.find(s => s.key === 'tag:5019441');
  expect(tag.label).toBe('TSTC006'); expect(tag.totalForVehicle).toBe(15.74);

  const sumCf = r.summary.find(s => s.key === 'plate:CF94HW');
  expect(sumCf.trips).toBe(2); expect(sumCf.total).toBe(1305.53); // two summary rows merged
  expect(r.summary.find(s => s.key === 'tag:99990001').trips).toBe(0);
  expect(r.invoice.totalTolls).toBe(1343.59);   // 15.74 + 5.25 + 8.80 + 6.06 + 1303.33 + 4.41
  expect(r.invoice.totalFees).toBe(2.75);

  const mini = path.join(path.dirname(fixturePdf), 'mini.pdf');
  fs.writeFileSync(mini, MINI_PDF);
  await expect(parseTollInvoice(mini)).rejects.toBeInstanceOf(TollParseError);
});

test('dropping the statement opens the review, pre-matched against the register', async ({ page }) => {
  await loginAs(page);
  await page.goto('/fleet');
  await expect(page.locator('a[href="/fleet/tolls"]').first()).toBeAttached();
  await expect(page.locator('[data-toll-kpi]')).toBeAttached();

  await page.goto('/fleet/tolls');
  await page.setInputFiles('#tollFile', fixturePdf);           // change → auto-submit
  await page.waitForURL(/\/fleet\/tolls\?review=\d+/);
  invoiceId = withDb(db => db.prepare('SELECT id FROM toll_invoices WHERE invoice_number = ?').get(INVOICE_NO)).id;
  expect(new URL(page.url()).searchParams.get('review')).toBe(String(invoiceId));

  const modal = page.locator('[data-toll-review]');
  await expect(modal).toBeVisible();
  await expect(modal).toContainText(INVOICE_NO);

  const sec = (key) => modal.locator(`[data-section="${key}"]`);
  // Tag matches by toll_tag; TSTC003 (Active) beats the Verify duplicate TSTC004.
  await expect(sec('tag:5019441').locator('[data-assign]')).toHaveValue(String(vehicleId('TSTC006')));
  await expect(sec('tag:5019441').locator('[data-include]')).toBeChecked();
  await expect(sec('tag:11701360').locator('[data-assign]')).toHaveValue(String(vehicleId('TSTC003')));
  // Plate matches by rego.
  await expect(sec('plate:CF94HW').locator('[data-assign]')).toHaveValue(String(vehicleId('TSTC POD 2')));
  // Two Active vehicles share tag 11793374 → nothing preselected, reviewer chooses.
  await expect(sec('tag:11793374')).toHaveAttribute('data-state', 'ambiguous');
  await expect(sec('tag:11793374').locator('[data-assign]')).toHaveValue('');
  await expect(sec('tag:11793374').locator('[data-include]')).not.toBeChecked();
  // Unknown plate + unknown tag are flagged with a prefilled "Add vehicle" link.
  await expect(sec('plate:ZZZ99Z')).toHaveAttribute('data-state', 'unmatched');
  await expect(sec('plate:ZZZ99Z')).toContainText('Not in register');
  const addHref = await sec('plate:ZZZ99Z').locator('[data-add-vehicle]').getAttribute('href');
  expect(addHref).toContain('rego=ZZZ99Z');
  expect(addHref).toContain('return_to=');
  await expect(sec('tag:55550001')).toHaveAttribute('data-state', 'unmatched');
  // Zero-trip tag is tucked away, not a row.
  await expect(modal.locator('[data-zero-trip]')).toContainText('99990001');
  // Matched sections are ticked, so the button is live.
  await expect(modal.locator('[data-review-submit]')).toBeEnabled();
});

test('add to vehicles: chosen vehicles, an un-ticked fee row, an edited amount, a learned tag', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/fleet/tolls?review=${invoiceId}`);
  const modal = page.locator('[data-toll-review]');
  const sec = (key) => modal.locator(`[data-section="${key}"]`);

  // Resolve the ambiguous tag and the unknown tag by hand.
  await sec('tag:11793374').locator('[data-assign]').selectOption(String(vehicleId('TSTC002')));
  await expect(sec('tag:11793374').locator('[data-include]')).toBeChecked();   // choosing a vehicle ticks it
  await sec('tag:55550001').locator('[data-assign]').selectOption(String(vehicleId('HILUX R1')));

  // Leave out CF94HW's fee row; edit the first 5019441 amount.
  await sec('plate:CF94HW').locator('[data-toggle-rows]').click();
  await sec('plate:CF94HW').locator('[data-row][data-fee="1"] [data-keep]').uncheck();
  await sec('tag:5019441').locator('[data-toggle-rows]').click();
  await sec('tag:5019441').locator('[data-row]').first().locator('[data-amt]').fill('5.00');

  await modal.locator('[data-review-submit]').click();
  await page.waitForURL(/\/fleet\/tolls\?review=\d+/);
  await expect(page.locator('body')).toContainText(/Saved: /);

  // 2 + 1 + 1 + 1 + 2 (fee row left out); ZZZ99Z stays unassigned.
  expect(tripCount()).toBe(7);
  const edited = withDb(db => db.prepare("SELECT amount, original_amount FROM toll_trips WHERE source_ref = '5019441' AND row_index = 0").get());
  expect(edited.amount).toBe(5); expect(edited.original_amount).toBe(5.25);
  const cfRows = withDb(db => db.prepare("SELECT is_fee FROM toll_trips WHERE source_ref = 'CF94HW'").all());
  expect(cfRows).toHaveLength(2); expect(cfRows.every(r => r.is_fee === 0)).toBe(true);
  // The tag section taught the register HILUX R1's tag.
  expect(withDb(db => db.prepare("SELECT toll_tag FROM vehicles WHERE asset_id = 'HILUX R1'").get()).toll_tag).toBe('55550001');

  // Reopened, the review shows what was done — and the un-ticked row stays un-ticked.
  await expect(modal.locator('[data-section][data-state="applied"]')).toHaveCount(5);
  await expect(modal).toContainText('Partly added');
  await expect(sec('plate:CF94HW').locator('[data-row][data-fee="1"] [data-keep]')).not.toBeChecked();
  await expect(modal.locator('[data-review-submit]')).toHaveText(/Update vehicles/);
});

test("the vehicle's Tolls tab shows its trips grouped by statement", async ({ page }) => {
  await loginAs(page);
  await page.goto(`/fleet/${vehicleId('TSTC006')}?tab=tolls`);
  const pane = page.locator('[data-v-pane="tolls"]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-toll-trip]')).toHaveCount(2);
  await expect(pane).toContainText('$15.49');                      // 5.00 (edited) + 10.49
  await expect(pane.locator('[data-toll-group]')).toHaveCount(1);
  await expect(pane).toContainText(INVOICE_NO);
  await expect(page.locator('[data-v-tab="tolls"] .v-tab-count')).toHaveText('2');
});

test('the same statement uploaded again just opens the existing one', async ({ page }) => {
  await loginAs(page);
  await page.goto('/fleet/tolls');
  await page.setInputFiles('#tollFile', fixturePdf);
  await page.waitForURL(/\/fleet\/tolls\?review=\d+/);
  expect(new URL(page.url()).searchParams.get('review')).toBe(String(invoiceId));
  await expect(page.locator('body')).toContainText(/already uploaded/);
  expect(withDb(db => db.prepare('SELECT COUNT(*) AS n FROM toll_invoices').get().n)).toBe(1);
  expect(tripCount()).toBe(7);
});

test('an unknown plate: Add vehicle from the hub, land back matched, reconcile the old statement', async ({ page }) => {
  await loginAs(page);
  await page.goto('/fleet/tolls');
  const item = page.locator('[data-unreconciled-item="plate:ZZZ99Z"]');
  await expect(item).toBeVisible();
  await expect(page.locator('[data-unreconciled-count]')).toHaveText('1');
  await item.locator('a', { hasText: 'Add vehicle' }).click();
  await expect(page).toHaveURL(/\/fleet\/new\?/);
  await expect(page.locator('input[name="rego"]')).toHaveValue('ZZZ99Z');
  await page.fill('input[name="asset_id"]', 'E2E-ZZZ');
  await page.locator('form[action="/fleet"] button[type="submit"]').first().click();
  await page.waitForURL(new RegExp(`/fleet/tolls\\?review=${invoiceId}`));

  const modal = page.locator('[data-toll-review]');
  const zzz = modal.locator('[data-section="plate:ZZZ99Z"]');
  await expect(zzz).toHaveAttribute('data-state', 'matched');
  await expect(zzz.locator('[data-assign]')).toHaveValue(String(vehicleId('E2E-ZZZ')));
  await expect(zzz.locator('[data-include]')).toBeChecked();
  await modal.locator('[data-review-submit]').click();
  await page.waitForURL(/\/fleet\/tolls\?review=\d+/);
  expect(tripCount()).toBe(9);
  await expect(page.locator('[data-toll-review]')).toContainText('Added to vehicles');

  await page.goto('/fleet/tolls');
  await expect(page.locator('[data-unreconciled]')).toHaveCount(0);
});

test('un-ticking an added section removes its trips; the PDF is private; delete cleans up', async ({ page }) => {
  await loginAs(page);
  await page.goto(`/fleet/tolls?review=${invoiceId}`);
  const modal = page.locator('[data-toll-review]');
  page.once('dialog', d => d.accept());
  await modal.locator('[data-section="plate:CF94HW"] [data-include]').uncheck();
  await modal.locator('[data-review-submit]').click();
  await page.waitForURL(/\/fleet\/tolls\?review=\d+/);
  expect(tripCount()).toBe(7);
  expect(withDb(db => db.prepare("SELECT COUNT(*) AS n FROM toll_trips WHERE source_ref = 'CF94HW'").get().n)).toBe(0);

  const file = await page.request.get(`/fleet/tolls/${invoiceId}/file`);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toContain('application/pdf');
  const stored = withDb(db => db.prepare('SELECT file_path FROM toll_invoices WHERE id = ?').get(invoiceId)).file_path;
  const direct = await page.request.get('/' + stored);
  expect(direct.status()).toBe(404);

  await page.goto('/fleet/tolls');
  page.once('dialog', d => d.accept());
  await page.locator(`[data-toll-invoice="${invoiceId}"] form[action$="/delete"] button`).click();
  await page.waitForURL(/\/fleet\/tolls$/);
  expect(withDb(db => db.prepare('SELECT COUNT(*) AS n FROM toll_invoices').get().n)).toBe(0);
  expect(tripCount()).toBe(0);
  expect(fs.existsSync(path.join(__dirname, '..', '..', stored))).toBe(false);
});

test('several past statements dropped at once are read and filed by period', async ({ page }) => {
  // Three different quarters in three different layouts + one duplicate.
  const a = await writeTollPdf({ name: 'jun.pdf' });                                   // long-form period (the 2026 layout)
  const b = await writeTollPdf({ name: 'mar.pdf', invoiceNo: '100099000002', periodStyle: 'numeric', periodNumeric: '03/12/2025 - 02/03/2026' });
  const c = await writeTollPdf({ name: 'odd.pdf', invoiceNo: '100099000003', periodStyle: 'none' }); // no period printed → from the trips
  const aAgain = await writeTollPdf({ name: 'jun-copy.pdf' });

  // Parser fallbacks first, directly.
  const pb = await parseTollInvoice(b);
  expect(pb.invoice.periodStart).toBe('2025-12-03'); expect(pb.invoice.periodEnd).toBe('2026-03-02'); expect(pb.invoice.periodSource).toBe('statement');
  const pc = await parseTollInvoice(c);
  expect(pc.invoice.periodStart).toBe('2026-04-30'); expect(pc.invoice.periodEnd).toBe('2026-06-02'); expect(pc.invoice.periodSource).toBe('trips');
  expect(pc.warnings[0]).toMatch(/earliest and latest trips/);

  await loginAs(page);
  await page.goto('/fleet/tolls');
  await page.setInputFiles('#tollFile', [a, b, c, aAgain]);
  await page.waitForURL(/\/fleet\/tolls$/);                       // several files → the list, not one review
  const body = page.locator('body');
  await expect(body).toContainText(/Read 3 statements, filed by period/);
  await expect(body).toContainText(/Already here, skipped/);
  expect(withDb(db => db.prepare('SELECT COUNT(*) AS n FROM toll_invoices').get().n)).toBe(3);

  // Newest period first; the oldest quarter (numeric layout) sits last, and
  // the statement with no printed period shows the range its trips cover.
  const rows = page.locator('[data-toll-invoice]');
  await expect(rows).toHaveCount(3);
  await expect(rows.last()).toContainText('03 Dec 2025 – 02 Mar 2026');
  await expect(rows.last()).toContainText('100099000002');
  await expect(page.locator('[data-toll-invoice]', { hasText: '100099000003' })).toContainText('30 Apr 2026 – 02 June 2026');

  // The review leads with the period and offers the next statement to work through.
  const first = await rows.first().getAttribute('data-toll-invoice');
  await page.goto(`/fleet/tolls?review=${first}`);
  const modal = page.locator('[data-toll-review]');
  await expect(modal.locator('h2').first()).toContainText(/Statement .*2026/);
  await expect(modal.locator('[data-review-next]')).toBeVisible();
  await expect(modal.locator('[data-review-next]')).toContainText(/Next: /);

  withDb(db => { db.prepare('DELETE FROM toll_trips').run(); db.prepare('DELETE FROM toll_invoices').run(); });
});
