// Purchase orders attached to a job — one row = one document plus the money
// it authorises (table job_purchase_orders, migration 349).
//
// Shared because the job detail page renders from TWO mounts: /jobs/:id
// (routes/jobs.js) and /projects/:id (routes/projects.js) both render
// views/jobs/show.ejs, and the edit form needs the same list. One query here
// keeps all three showing the same thing.

'use strict';

function listPurchaseOrders(db, jobId) {
  return db.prepare(`
    SELECT po.id, po.title, po.description, po.amount, po.original_name, po.mime_type,
           po.size_bytes, po.uploaded_at, u.full_name AS uploaded_by_name
    FROM job_purchase_orders po
    LEFT JOIN users u ON po.uploaded_by_id = u.id
    WHERE po.job_id = ? AND po.archived_at IS NULL
    ORDER BY po.uploaded_at DESC, po.id DESC
  `).all(jobId);
}

// Never let a legacy DB missing the table (mig 349) take a job page down —
// the tab just renders empty.
function safeListPurchaseOrders(db, jobId) {
  try { return listPurchaseOrders(db, jobId); }
  catch (e) { console.error('[purchaseOrders] list failed for job', jobId, ':', e.message); return []; }
}

// "$12,500.00" / "12500" → 12500. Anything unparseable is 0 rather than NaN,
// which would land in the DB and render as blank.
function parsePoAmount(raw) {
  const n = parseFloat(String(raw == null ? '' : raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = { listPurchaseOrders, safeListPurchaseOrders, parsePoAmount };
