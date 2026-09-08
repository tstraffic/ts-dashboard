// Plans & Approvals — unified Documents zone, attach-only uploads, ROL
// parse-from-attached, TGS↔ROL many-to-many links, streamlined selects.
//
// Previously: uploading files to a sub-plan ALWAYS submitted it (status →
// submitted + required description/date/hours); the ROL workflow demanded
// its own upload even when the ROL PDF was already attached; a TGS could
// link to exactly ONE ROL (compliance.linked_rol_id); and creating plans
// meant one owner <select> per type row plus a type dropdown to add more.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// A minimal but genuinely parseable PDF: pdfjs reads the one text run, so
// the ROL parser extracts "LICENCE NO 98765" and the review page renders
// with real data — no binary fixture needed in the repo.
const MINI_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (LICENCE NO 98765) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Size 6/Root 1 0 R>>\n%%EOF'
);

// Parent plan + one TGS + two ROL sub-plans, fresh each run.
function seedPlan(opts = {}) {
  return withDb(db => {
    db.prepare("DELETE FROM compliance WHERE title LIKE 'JPPLAN %'").run();
    db.prepare(`
      INSERT INTO compliance (parent_id, plan_number, item_type, title, status)
      VALUES (NULL, 9901, 'other', 'JPPLAN parent', 'not_started')
    `).run();
    const parentId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const mkSub = (type, ref, title) => {
      db.prepare(`
        INSERT INTO compliance (parent_id, item_type, title, reference_number, status)
        VALUES (?, ?, ?, ?, 'not_started')
      `).run(parentId, type, title, ref);
      return db.prepare('SELECT last_insert_rowid() AS id').get().id;
    };
    const tgsId = mkSub('traffic_guidance', 'TSTGS-E2E', 'JPPLAN tgs');
    // opts.rols === false seeds a TGS-only plan (no ROL to cover it).
    const rol1 = opts.rols === false ? null : mkSub('rol', 'TSROL-E2E-1', 'JPPLAN rol one');
    const rol2 = opts.rols === false ? null : mkSub('rol', 'TSROL-E2E-2', 'JPPLAN rol two');
    try { db.prepare('DELETE FROM compliance_tgs_rol_links WHERE tgs_id = ?').run(tgsId); } catch (e) {}
    return { parentId, tgsId, rol1, rol2 };
  });
}

const editUrl = (seed) => `/compliance/${seed.parentId}/edit`;

// Sub-plan cards are collapsed <details> rows (the row IS the summary);
// interacting with a card's body needs it open first.
async function openCard(page, subId) {
  await page.evaluate((id) => {
    const el = document.getElementById('sub-' + id);
    if (el && 'open' in el) el.open = true;
  }, subId);
}

test('dropping files on a sub-plan attaches them WITHOUT submitting', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  const card = page.locator(`#sub-${seed.tgsId}`);
  await openCard(page, seed.tgsId);
  await expect(card).toBeVisible();
  // setInputFiles fires `change` — the same event the dropzone dispatches
  // on drop — which auto-submits the attach-only form.
  await card.locator('form[data-attach-form] input[type="file"]')
    .setInputFiles({ name: 'jp-attach.pdf', mimeType: 'application/pdf', buffer: MINI_PDF });
  await page.waitForLoadState('networkidle');

  await expect(page.locator(`#sub-${seed.tgsId}`)).toContainText('jp-attach.pdf');
  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('not_started'); // attach ≠ submit
});

test('the plan can then be SUBMITTED without re-picking files', async ({ page }) => {
  const seed = seedPlan();
  withDb(db => {
    db.prepare(`
      INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, 'pre.pdf', 'pre.pdf', '/data/uploads/compliance/${seed.tgsId}/pre.pdf', 100, 'application/pdf')
    `).run(seed.tgsId);
  });
  await loginAs(page);
  await page.goto(editUrl(seed));

  const card = page.locator(`#sub-${seed.tgsId}`);
  await openCard(page, seed.tgsId);
  // The Submit plan disclosure is OPEN by default on an un-lodged plan
  // (Aug 2026 — it leads the card now); a blind summary click would close
  // it. Ensure open whichever state it starts in.
  await card.locator('details', { has: page.locator('form[action*="upload-submit"]') })
    .evaluate(el => { el.open = true; });
  const submitForm = card.locator('form[action*="upload-submit"]');
  await submitForm.locator('input[name="description"]').fill('E2E submitted with attached docs');
  await submitForm.locator('input[name="hours_spent"]').fill('0.5');
  // NO file selected — the already-attached doc satisfies the server rule,
  // and the file input's `required` is relaxed when docs exist.
  await submitForm.locator('button', { hasText: 'Upload & Submit' }).click();
  await page.waitForLoadState('networkidle');

  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('submitted');
});

test('upload-submit still validates (missing hours blocks it)', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.tgsId}`);
  await openCard(page, seed.tgsId);
  await card.locator('details', { has: page.locator('form[action*="upload-submit"]') })
    .evaluate(el => { el.open = true; });
  await card.locator('form[action*="upload-submit"] input[name="description"]').fill('Missing hours');
  // Attach a file so the file rule passes; hours left empty. The browser's
  // own `required` blocks first — clear it to exercise the server rule.
  await card.locator('form[action*="upload-submit"] input[type="file"]')
    .setInputFiles({ name: 'v.pdf', mimeType: 'application/pdf', buffer: MINI_PDF });
  await card.locator('form[action*="upload-submit"] input[name="hours_spent"]').evaluate(el => el.removeAttribute('required'));
  await card.locator('form[action*="upload-submit"] button', { hasText: 'Upload & Submit' }).click();
  await page.waitForLoadState('networkidle');

  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('not_started');
  await expect(page.locator('body')).toContainText(/hours/i);
});

test('an attached issued-ROL PDF auto-approves in one click', async ({ page }) => {
  const seed = seedPlan();
  // Attach a parseable PDF to the ROL sub-plan on disk + in the DB, the
  // exact shape the attach route produces.
  withDb(db => {
    const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'compliance', String(seed.rol1));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'e2e-rol.pdf'), MINI_PDF);
    db.prepare(`
      INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, 'e2e-rol.pdf', 'e2e-rol.pdf', '/data/uploads/compliance/${seed.rol1}/e2e-rol.pdf', ${MINI_PDF.length}, 'application/pdf')
    `).run(seed.rol1);
  });

  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.rol1}`);
  await openCard(page, seed.rol1);

  // The attached PDF is offered in the auto-approve zone — one click parses
  // it AND approves the ROL, no review step, no re-upload.
  const docRow = card.locator('[data-rol-existing-docs]');
  await expect(docRow).toContainText('e2e-rol.pdf');
  await docRow.locator('button', { hasText: 'Read & approve' }).click();
  await page.waitForLoadState('networkidle');

  const row = withDb(db => db.prepare('SELECT rol_file_path, rol_stage, status, rol_actual_number FROM compliance WHERE id = ?').get(seed.rol1));
  expect(row.rol_file_path).toBe(`/data/uploads/compliance/${seed.rol1}/e2e-rol.pdf`);
  expect(row.rol_stage).toBe('approved');
  expect(row.status).toBe('approved');       // stage and status move together now
  expect(row.rol_actual_number).toBe('98765');

  // The captured licence number shows beside the TS reference.
  await expect(page.locator(`#sub-${seed.rol1}`)).toContainText('ROL 98765');
});

test('a TGS links to MULTIPLE ROLs, with back-links, and unlinks cleanly', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  const tgsCard = page.locator(`#sub-${seed.tgsId}`);
  await openCard(page, seed.tgsId);
  await tgsCard.locator('[data-rol-links] button', { hasText: 'TSROL-E2E-1' }).click();
  await page.waitForLoadState('networkidle');
  await openCard(page, seed.tgsId);
  await page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'TSROL-E2E-2' }).click();
  await page.waitForLoadState('networkidle');

  let links = withDb(db => db.prepare('SELECT rol_id FROM compliance_tgs_rol_links WHERE tgs_id = ? ORDER BY rol_id').all(seed.tgsId));
  expect(links.map(l => l.rol_id)).toEqual([seed.rol1, seed.rol2]);

  // Both ROL cards carry the back-link.
  await openCard(page, seed.rol1);
  await openCard(page, seed.rol2);
  await expect(page.locator(`#sub-${seed.rol1} [data-tgs-backlinks]`)).toContainText('TSTGS-E2E');
  await expect(page.locator(`#sub-${seed.rol2} [data-tgs-backlinks]`)).toContainText('TSTGS-E2E');

  // Unlink one — the other survives.
  await openCard(page, seed.tgsId);
  await page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'TSROL-E2E-1' }).click();
  await page.waitForLoadState('networkidle');
  links = withDb(db => db.prepare('SELECT rol_id FROM compliance_tgs_rol_links WHERE tgs_id = ?').all(seed.tgsId));
  expect(links.map(l => l.rol_id)).toEqual([seed.rol2]);
});

test('deleting a ROL that a TGS points at succeeds (no FK 500)', async ({ page }) => {
  const seed = seedPlan();
  // Two ways a TGS can reference a ROL: the retired linked_rol_id column
  // (mig 317, REFERENCES compliance(id) with NO ON DELETE — it held the row
  // hostage and the delete route 500'd with "FOREIGN KEY constraint
  // failed") and the current join table.
  withDb(db => {
    db.prepare('UPDATE compliance SET linked_rol_id = ? WHERE id = ?').run(seed.rol1, seed.tgsId);
    db.prepare('INSERT OR IGNORE INTO compliance_tgs_rol_links (tgs_id, rol_id) VALUES (?, ?)').run(seed.tgsId, seed.rol1);
  });

  await loginAs(page);
  await page.goto(editUrl(seed));
  const res = await page.evaluate(async (subId) => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta ? meta.getAttribute('content') : '';
    const r = await fetch(`/compliance/sub-plans/${subId}/delete`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': token },
      body: new URLSearchParams({ _csrf: token }),
      credentials: 'same-origin',
    });
    return { status: r.status, body: await r.text() };
  }, seed.rol1);

  expect(res.status, res.body).toBe(200);
  const after = withDb(db => ({
    rol: db.prepare('SELECT 1 FROM compliance WHERE id = ?').get(seed.rol1),
    tgs: db.prepare('SELECT linked_rol_id FROM compliance WHERE id = ?').get(seed.tgsId),
    links: db.prepare('SELECT COUNT(*) AS n FROM compliance_tgs_rol_links WHERE rol_id = ?').get(seed.rol1).n,
  }));
  expect(after.rol).toBeFalsy();              // the ROL is gone
  expect(after.tgs.linked_rol_id).toBeNull(); // the TGS survives, detached
  expect(after.links).toBe(0);                // and its links are cleaned up
});

test('quick-add buttons create sub-plans without the type dropdown', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  await page.locator('details summary', { hasText: 'Add a sub-plan' }).click();
  await page.locator('[data-quick-add="spa"]').click();
  await page.waitForLoadState('networkidle');
  const spa = withDb(db => db.prepare("SELECT id, reference_number FROM compliance WHERE parent_id = ? AND item_type = 'spa'").get(seed.parentId));
  expect(spa).toBeTruthy();
  expect(spa.reference_number).toMatch(/^TSSPA/);

  // "Other" needs a description first — its button reveals the inline form.
  await page.locator('details summary', { hasText: 'Add a sub-plan' }).click();
  await page.locator('[data-quick-add="other"]').click();
  await page.locator('#addOtherForm input[name="other_description"]').fill('Environmental approval');
  await page.locator('#addOtherForm button', { hasText: 'Add Other' }).click();
  await page.waitForLoadState('networkidle');
  const other = withDb(db => db.prepare("SELECT other_description FROM compliance WHERE parent_id = ? AND item_type = 'other' AND parent_id IS NOT NULL").get(seed.parentId));
  expect(other && other.other_description).toBe('Environmental approval');
});

test('plan creation: one default owner covers every type, override wins per type', async ({ page }) => {
  const users = withDb(db => db.prepare('SELECT id FROM users ORDER BY id LIMIT 2').all());
  test.skip(users.length < 2, 'needs two users');
  await loginAs(page);
  await page.goto('/compliance/new');

  await page.fill('input[name="title"]', 'JPPLAN default-owner probe');
  await page.selectOption('select[name="default_owner_id"]', String(users[0].id));

  // Tick TGS + ROL; leave owners at the default.
  await page.locator('.type-toggle[data-type="traffic_guidance"]').check();
  await page.locator('.type-toggle[data-type="rol"]').check();
  // Per-type override for ROL only.
  await page.locator('#customiseOwners').check();
  await page.selectOption('select[name="owner_rol"]', String(users[1].id));

  await page.locator('button', { hasText: 'Create Plan' }).click();
  await page.waitForLoadState('networkidle');

  const rows = withDb(db => db.prepare(`
    SELECT c.item_type, c.assigned_to_id FROM compliance c
    JOIN compliance p ON p.id = c.parent_id
    WHERE p.title = 'JPPLAN default-owner probe'
  `).all());
  const byType = Object.fromEntries(rows.map(r => [r.item_type, r.assigned_to_id]));
  expect(byType.traffic_guidance).toBe(users[0].id); // default owner
  expect(byType.rol).toBe(users[1].id);              // per-type override
});

// ── TGS packages, per-sheet ROL links, ROL matrix, extension auto-fill,
//    register upgrades (Sep 2026 office asks) ────────────────────────────

// A pdfkit-generated issued/extension ROL the parser reads end to end:
// LICENCE NO + explicit From/To. Written to the sub-plan's upload dir so it
// looks exactly like an attach.
function writeRolPdf(subId, name, licenceNo, from, to) {
  const PDFDocument = require('pdfkit');
  const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'compliance', String(subId));
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4' });
    const ws = fs.createWriteStream(abs);
    doc.pipe(ws);
    doc.fontSize(12).text('ROAD OCCUPANCY LICENCE');
    doc.text('LICENCE NO : ' + licenceNo);
    doc.text('LICENCE DURATION');
    doc.text('From: ' + from);
    doc.text('To: ' + to);
    doc.end();
    ws.on('finish', () => resolve({ abs, rel: `/data/uploads/compliance/${subId}/${name}` }));
    ws.on('error', reject);
  });
}

test('a TGS package holds many sheets, each linkable to any ROL, and the ROL table oversees it', async ({ page }) => {
  const seed = seedPlan();
  // Two sheets in the TGS package; approve ROL 1 so it renders a tick.
  const sheets = withDb(db => {
    const ins = db.prepare(`INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, ?, ?, ?, 10, 'application/pdf')`);
    const a = ins.run(seed.tgsId, 'sheet-A.pdf', 'sheet-A.pdf', `/x/A.pdf`).lastInsertRowid;
    const b = ins.run(seed.tgsId, 'sheet-B.pdf', 'sheet-B.pdf', `/x/B.pdf`).lastInsertRowid;
    db.prepare("UPDATE compliance SET status='approved', rol_stage='approved', rol_actual_number='LIC-700' WHERE id=?").run(seed.rol1);
    return { a, b };
  });

  await loginAs(page);
  await page.goto(editUrl(seed));

  // Before anyone links anything, every ROL on the plan covers every sheet
  // (the "plan-wide" default) — so the approved licence already ticks. This
  // is what existing plans rely on: nobody goes back to click link chips.
  const panel = page.locator('[data-tab-panel="roltable"]');
  await page.locator('[data-tab="roltable"]').click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(4); // 2 sheets × 2 ROLs
  await expect(panel).toContainText('plan-wide');
  expect(await panel.locator('[title="ROL approved"]').count()).toBe(2);
  expect(await panel.locator('[title="ROL not approved yet"]').count()).toBe(2);
  // The ROL card says what it covers by default, and the package chips show it.
  await openCard(page, seed.rol1);
  await expect(page.locator(`#sub-${seed.rol1} [data-tgs-backlinks]`)).toContainText('TSTGS-E2E');
  await expect(page.locator(`#sub-${seed.rol1} [data-tgs-backlinks]`)).toContainText('plan-wide');

  await page.locator('[data-tab="subplans"]').click();
  await openCard(page, seed.tgsId);
  await expect(page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'LIC-700' })).toContainText('◦');

  // Each sheet carries its own ROL chip row; link sheet A → ROL 1 (doc-level).
  const sheetA = page.locator(`[data-doc-rol-links="${sheets.a}"]`);
  await expect(sheetA).toBeVisible();
  await sheetA.locator('button', { hasText: 'LIC-700' }).click();
  await page.waitForLoadState('networkidle');

  const linkRow = withDb(db => db.prepare('SELECT rol_id FROM compliance_doc_rol_links WHERE document_id = ?').get(sheets.a));
  expect(linkRow.rol_id).toBe(seed.rol1);

  // Package-level link still works alongside (covers sheet B too).
  await page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'TSROL-E2E-2' }).click();
  await page.waitForLoadState('networkidle');

  // ROL table: explicit links NARROW the default — A → LIC-700 (own) + ROL 2
  // (package), B → ROL 2 (package). Nothing is plan-wide any more.
  await page.locator('[data-tab="roltable"]').click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(3);
  await expect(panel).not.toContainText('plan-wide');
  await expect(panel).toContainText('sheet-A.pdf');
  await expect(panel).toContainText('LIC-700');
  await expect(panel).toContainText('package link');
  // The header carries an Ext column even before any extension exists.
  await expect(panel.locator('thead')).toContainText('Ext 1');
});

test('a plan with no ROL shows the empty box in the ROL table', async ({ page }) => {
  const seed = seedPlan({ rols: false });
  withDb(db => db.prepare(`INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
    VALUES (?, 'lone.pdf', 'lone.pdf', '/x/lone.pdf', 10, 'application/pdf')`).run(seed.tgsId));

  await loginAs(page);
  await page.goto(editUrl(seed));
  await page.locator('[data-tab="roltable"]').click();
  const panel = page.locator('[data-tab-panel="roltable"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(1);
  await expect(panel.locator('[title="No ROL on this plan yet"]')).toBeVisible();
  expect(await panel.locator('[title="ROL approved"]').count()).toBe(0);
  await expect(panel).not.toContainText('plan-wide');
});

test('an extension auto-fills its end date from the re-issued ROL PDF', async ({ page }) => {
  const seed = seedPlan();
  // Give the ROL a licence number + printed end so the move is visible.
  withDb(db => db.prepare("UPDATE compliance SET status='approved', rol_stage='approved', rol_actual_number='55501', rol_summary_to='2026-09-15', expiry_date='2026-09-15' WHERE id=?").run(seed.rol1));
  const pdf = await writeRolPdf(seed.rol1, 'ext.pdf', '55501', '01-Sep-2026', '30-Sep-2026');

  await loginAs(page);
  // Post the extension with the PDF and NO extended_to — the parser fills it.
  const res = await page.request.post(`/compliance/sub-plans/${seed.rol1}/extensions`, {
    multipart: {
      _csrf: await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content || ''),
      extended_to: '',
      reason: '',
      extension_file: { name: 'ext.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(pdf.abs) },
    },
  });
  expect([200, 302]).toContain(res.status());

  const ext = withDb(db => db.prepare('SELECT extended_to, reason FROM compliance_extensions WHERE compliance_id = ?').get(seed.rol1));
  expect(ext.extended_to).toBe('2026-09-30');                 // from the PDF's To: line
  expect(ext.reason).toContain('55501');                       // auto reason names the licence
  const rol = withDb(db => db.prepare('SELECT expiry_date, rol_summary_to FROM compliance WHERE id = ?').get(seed.rol1));
  expect(rol.expiry_date).toBe('2026-09-30');                  // effective end moved
  expect(rol.rol_summary_to).toBe('2026-09-15');               // printed end preserved
});

test('the register searches sub-plan refs and filters urgent rows', async ({ page }) => {
  const seed = seedPlan();
  // Make the parent findable by a sub-plan ref, and urgent (started).
  withDb(db => {
    db.prepare("UPDATE compliance SET title='JPPLAN searchable plan', status='started' WHERE id=?").run(seed.parentId);
    db.prepare("UPDATE compliance SET rol_actual_number='FINDME-999' WHERE id=?").run(seed.rol1);
  });
  await loginAs(page);

  // Search by the real ROL licence number (lives on a sub-plan).
  await page.goto('/compliance?q=FINDME-999');
  await expect(page.locator('tr.month-row', { hasText: 'JPPLAN searchable plan' })).toHaveCount(1);

  // A miss returns nothing.
  await page.goto('/compliance?q=zzz-no-such-ref');
  await expect(page.locator('tr.month-row', { hasText: 'JPPLAN searchable plan' })).toHaveCount(0);

  // Urgent keeps the started plan and never shows an approved-only one.
  await page.goto('/compliance?urgent=1');
  await expect(page.locator('tr.month-row', { hasText: 'JPPLAN searchable plan' })).toHaveCount(1);
});
