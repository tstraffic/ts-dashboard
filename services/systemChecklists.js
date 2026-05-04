/**
 * System checklist resolver.
 *
 * The 5 Job-Pack checklists used to be defined as hardcoded JS arrays
 * inside routes/worker/forms.js. Migration 151 promoted them into
 * editable checklist_templates rows tagged with a `system_key`, with
 * each Publish snapshotting the current items as a numbered revision
 * in checklist_template_revisions.
 *
 * `getSystemItems(systemKey, hardcodedFallback)` returns the items
 * the worker form should render. It always tries the latest published
 * revision first; if no revision is found (legacy DB before mig 151,
 * or admin hasn't published yet) it returns the caller-supplied
 * hardcoded fallback so the worker portal never breaks.
 *
 * The shape returned is:
 *   { item_order, section, item_key, question, response_type, required, options }
 * which is what the existing form EJS templates expect.
 */
const { getDb } = require('../db/database');

function getSystemItems(systemKey, fallback) {
  if (!systemKey) return fallback || [];
  try {
    const db = getDb();
    const tpl = db.prepare(`
      SELECT id, published_revision FROM checklist_templates
      WHERE system_key = ? AND status = 'active' AND worker_visible = 1
    `).get(systemKey);
    if (!tpl || !tpl.published_revision) return fallback || [];
    const rev = db.prepare(`
      SELECT items_json FROM checklist_template_revisions
      WHERE template_id = ? AND revision_number = ?
    `).get(tpl.id, tpl.published_revision);
    if (!rev) return fallback || [];
    const parsed = JSON.parse(rev.items_json || '[]');
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback || [];
    // Normalise back to the shape the EJS expects (some legacy snapshot
    // rows from before this column landed may not have item_key —
    // synthesize one from the question text in that case).
    return parsed.map((it, idx) => ({
      item_order: it.item_order != null ? it.item_order : idx,
      section: it.section || '',
      item_key: it.item_key || ('q' + (idx + 1)),
      question: it.question || '',
      response_type: it.response_type || 'yes_no_na',
      required: it.required ? 1 : 0,
      options: it.options || (it.options_json ? safeJson(it.options_json) : null),
    }));
  } catch (e) {
    return fallback || [];
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

module.exports = { getSystemItems };
