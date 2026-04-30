// Admin review of signed dockets (docket_signatures). Workers fill at
// /w/dockets/sign/:allocationId; this is the office-side list + detail.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /dockets — list view with filters
router.get('/', (req, res) => {
  const db = getDb();
  const since = (req.query.since || '').trim(); // YYYY-MM-DD
  const search = (req.query.q || '').trim();
  const docketType = (req.query.docket_type || '').trim();
  const noClient = req.query.no_client === '1';

  const where = ['1=1'];
  const params = [];
  if (since)      { where.push("date(ds.signed_at) >= date(?)"); params.push(since); }
  if (docketType) { where.push("ds.docket_type = ?"); params.push(docketType); }
  if (noClient)   { where.push("ds.no_client_on_site = 1"); }
  if (search) {
    where.push("(cm.full_name LIKE ? OR j.job_number LIKE ? OR j.client LIKE ? OR ds.client_name LIKE ?)");
    const s = '%' + search + '%';
    params.push(s, s, s, s);
  }

  const rows = db.prepare(`
    SELECT ds.id, ds.signed_at, ds.docket_type, ds.client_name, ds.no_client_on_site,
      ds.start_on_site, ds.finish_on_site, ds.total_hours,
      ds.signature_data IS NOT NULL  AS has_worker_sig,
      ds.client_signature IS NOT NULL AS has_client_sig,
      ds.crew_member_id, ds.allocation_id,
      cm.full_name AS crew_name,
      ca.allocation_date,
      j.id AS job_id, j.job_number, j.client AS job_client, j.job_name
    FROM docket_signatures ds
    LEFT JOIN crew_members cm   ON ds.crew_member_id = cm.id
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs j            ON ca.job_id = j.id
    WHERE ${where.join(' AND ')}
    ORDER BY ds.signed_at DESC
    LIMIT 200
  `).all(...params);

  // Counts for filter chips
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN no_client_on_site = 1 THEN 1 ELSE 0 END) AS no_client
    FROM docket_signatures
    WHERE date(signed_at) >= date('now','-30 day')
  `).get();

  res.render('dockets-admin/index', {
    title: 'Signed Dockets',
    rows,
    counts,
    search,
    since,
    docketType,
    noClient,
  });
});

// GET /dockets/:id — submission detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const docket = db.prepare(`
    SELECT ds.*,
      cm.full_name AS crew_name, cm.employee_id AS employee_code, cm.phone AS crew_phone,
      ca.allocation_date, ca.start_time AS shift_start, ca.end_time AS shift_end,
      ca.role_on_site,
      j.id AS job_id, j.job_number, j.client AS job_client, j.job_name, j.site_address
    FROM docket_signatures ds
    LEFT JOIN crew_members cm    ON ds.crew_member_id = cm.id
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs j             ON ca.job_id = j.id
    WHERE ds.id = ?
  `).get(req.params.id);
  if (!docket) {
    req.flash('error', 'Docket not found.');
    return res.redirect('/dockets');
  }

  // Show this worker's Job-Pack submissions for the same allocation so the
  // reviewer can sanity-check that the docket isn't sitting on top of a
  // missing prestart pack.
  let companionForms = [];
  if (docket.allocation_id) {
    companionForms = db.prepare(`
      SELECT id, form_type, submitted_at FROM safety_forms
      WHERE crew_member_id = ? AND allocation_id = ?
        AND form_type IN ('vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle')
      ORDER BY submitted_at ASC
    `).all(docket.crew_member_id, docket.allocation_id);
  }

  res.render('dockets-admin/show', {
    title: 'Docket — ' + (docket.crew_name || ('#' + docket.crew_member_id)),
    docket,
    companionForms,
  });
});

module.exports = router;
