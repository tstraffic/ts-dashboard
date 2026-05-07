// Compliance Plan P&L register — admin + finance only.
//
// Rolls up every parent compliance plan with:
//   hours · client charge · council fees · T&S labour cost ·
//   total cost · profit/loss
//
// Internal cost = hours × system_config.internal_hourly_rate.
// Council fees flow into cost too (they're a pass-through expense to T&S).
//
// Gated at the route level by requireRole('admin','finance') so the
// numbers never reach planning/operations.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { getConfig } = require('../middleware/settings');

router.use(requireRole('admin', 'finance'));

router.get('/', (req, res) => {
  const db = getDb();
  const { job_id, client_id, status, has_charge } = req.query;
  const hourlyRate = parseFloat(getConfig('internal_hourly_rate', 40)) || 40;

  // One row per parent plan, with totals rolled up from its sub-plans.
  // Aggregating in SQL keeps the page fast even with many plans.
  let where = `WHERE p.parent_id IS NULL AND p.plan_number IS NOT NULL`;
  const params = [];
  if (job_id)    { where += ` AND p.job_id = ?`;    params.push(job_id); }
  if (client_id) { where += ` AND p.client_id = ?`; params.push(client_id); }
  if (status && status !== 'all') { where += ` AND p.status = ?`; params.push(status); }

  // Compliance plans can be linked to either a job OR a tender (mutually
  // exclusive in practice). The register shows whichever one is set so a
  // tender-stage plan doesn't display a blank/incorrect Job column.
  const plans = db.prepare(`
    SELECT p.id, p.plan_number, p.title, p.status, p.created_at,
      p.tender_id,
      j.id AS job_id, j.job_number, j.project_name,
      t.tender_number, t.title AS tender_title, t.status AS tender_status,
      cl.company_name AS client_name,
      COALESCE(SUM(s.hours_spent), 0) AS total_hours,
      COALESCE(SUM(CASE WHEN s.charge_client = 1 THEN s.charge_amount ELSE 0 END), 0) AS total_charge,
      COALESCE(SUM(CASE WHEN s.council_fee_paid = 1 THEN s.council_fee_amount ELSE 0 END), 0) AS total_council,
      COUNT(s.id) AS sub_count,
      SUM(CASE WHEN s.status IN ('submitted','approved') THEN 1 ELSE 0 END) AS submitted_count
    FROM compliance p
    LEFT JOIN compliance s ON s.parent_id = p.id
    LEFT JOIN jobs j ON p.job_id = j.id
    LEFT JOIN tenders t ON p.tender_id = t.id
    LEFT JOIN clients cl ON p.client_id = cl.id
    ${where}
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(...params);

  // Compute cost/profit in JS rather than SQL — keeps the math next to
  // the rate constant and easy to change later.
  const rows = plans.map(p => {
    const labour = (p.total_hours || 0) * hourlyRate;
    const cost = labour + (p.total_council || 0);
    const profit = (p.total_charge || 0) - cost;
    return { ...p, labour_cost: labour, total_cost: cost, profit };
  });

  if (has_charge === '1') {
    // Hide rows where there's no client charge yet — useful when finance
    // wants to focus only on plans that should be reconciled.
    rows.splice(0, rows.length, ...rows.filter(r => r.total_charge > 0));
  }

  const totals = rows.reduce((acc, r) => {
    acc.hours += r.total_hours || 0;
    acc.charge += r.total_charge || 0;
    acc.council += r.total_council || 0;
    acc.labour += r.labour_cost || 0;
    acc.cost += r.total_cost || 0;
    acc.profit += r.profit || 0;
    return acc;
  }, { hours: 0, charge: 0, council: 0, labour: 0, cost: 0, profit: 0 });

  const jobs = db.prepare(`SELECT DISTINCT j.id, j.job_number, j.project_name, j.client FROM jobs j INNER JOIN compliance c ON c.job_id = j.id WHERE c.parent_id IS NULL ORDER BY j.job_number DESC`).all();
  const clients = db.prepare(`SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name`).all();

  res.render('finance/pnl', {
    title: 'Compliance Plan P&L',
    currentPage: 'finance-pnl',
    rows, totals, hourlyRate,
    jobs, clients,
    filters: { job_id: job_id || '', client_id: client_id || '', status: status || 'all', has_charge: has_charge || '' },
  });
});

module.exports = router;
