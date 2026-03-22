const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');

router.get('/', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 8) + '01';

  const fromDate = req.query.from || monthStart;
  const toDate = req.query.to || today;
  const activeTab = req.query.tab || 'crew';
  const canViewFinance = canViewAccounts(req.session.user);

  // Jobs list for Quick Exports tab
  const jobs = db.prepare(`SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won','completed') ORDER BY job_number`).all();

  // ── Tab 1: Crew Utilisation ──
  const crewAllocations = db.prepare(`
    SELECT cm.id, cm.full_name, cm.role,
      COUNT(ca.id) as allocation_count,
      COUNT(DISTINCT ca.allocation_date) as days_allocated
    FROM crew_members cm
    LEFT JOIN crew_allocations ca ON cm.id = ca.crew_member_id
      AND ca.allocation_date BETWEEN ? AND ?
      AND ca.status NOT IN ('cancelled')
    WHERE cm.active = 1
    GROUP BY cm.id ORDER BY allocation_count DESC
  `).all(fromDate, toDate);

  const crewHours = db.prepare(`
    SELECT cm.id, cm.full_name, cm.role,
      COALESCE(SUM(t.total_hours), 0) as total_hours,
      COALESCE(SUM(t.overtime_hours), 0) as overtime_hours,
      COUNT(DISTINCT t.work_date) as days_worked
    FROM crew_members cm
    LEFT JOIN timesheets t ON cm.id = t.crew_member_id
      AND t.work_date BETWEEN ? AND ?
    WHERE cm.active = 1
    GROUP BY cm.id ORDER BY total_hours DESC
  `).all(fromDate, toDate);

  const dailyAllocations = db.prepare(`
    SELECT allocation_date as date, COUNT(*) as count
    FROM crew_allocations
    WHERE allocation_date BETWEEN ? AND ? AND status NOT IN ('cancelled')
    GROUP BY allocation_date ORDER BY date ASC
  `).all(fromDate, toDate);

  const fatigueRisk = db.prepare(`
    SELECT cm.id, cm.full_name, COALESCE(SUM(t.total_hours), 0) as week_hours
    FROM timesheets t
    JOIN crew_members cm ON t.crew_member_id = cm.id
    WHERE t.work_date BETWEEN date(?, '-6 days') AND ?
    GROUP BY cm.id HAVING week_hours > 50
  `).all(toDate, toDate);

  // Merge crew data
  const hoursMap = {};
  crewHours.forEach(c => { hoursMap[c.id] = c; });
  const fatigueSet = new Set(fatigueRisk.map(f => f.id));
  const crewData = crewAllocations.map(c => ({
    ...c,
    total_hours: (hoursMap[c.id] || {}).total_hours || 0,
    overtime_hours: (hoursMap[c.id] || {}).overtime_hours || 0,
    days_worked: (hoursMap[c.id] || {}).days_worked || 0,
    fatigue: fatigueSet.has(c.id)
  }));

  const activeCrew = crewAllocations.filter(c => c.allocation_count > 0 || (hoursMap[c.id] || {}).total_hours > 0).length;
  const totalCrewHours = crewHours.reduce((s, c) => s + c.total_hours, 0);
  const avgDaysAllocated = crewAllocations.length ? (crewAllocations.reduce((s, c) => s + c.days_allocated, 0) / crewAllocations.filter(c => c.days_allocated > 0).length || 0) : 0;

  // ── Tab 2: Job Health ──
  const jobsByStatus = db.prepare(`SELECT status, COUNT(*) as count FROM jobs GROUP BY status`).all();
  const jobsByHealth = db.prepare(`SELECT health, COUNT(*) as count FROM jobs WHERE status = 'active' GROUP BY health`).all();
  const activeJobCount = db.prepare(`SELECT COUNT(*) as count FROM jobs WHERE status = 'active'`).get().count;
  const redHealth = (jobsByHealth.find(j => j.health === 'red') || {}).count || 0;

  const overdueJobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.end_date, j.health, u.full_name as pm_name
    FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.end_date < ? AND j.status NOT IN ('completed','closed','lost')
    ORDER BY j.end_date ASC LIMIT 20
  `).all(today);

  const overBudgetJobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.status, b.contract_value,
      COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) as total_spent
    FROM jobs j JOIN job_budgets b ON j.id = b.job_id
    WHERE b.contract_value > 0
    GROUP BY j.id HAVING total_spent > b.contract_value
    ORDER BY (total_spent - b.contract_value) DESC LIMIT 20
  `).all();

  const staleJobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.last_update_date, u.full_name as pm_name
    FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status = 'active' AND (j.last_update_date IS NULL OR j.last_update_date < date(?, '-7 days'))
    ORDER BY j.last_update_date ASC LIMIT 20
  `).all(today);

  // ── Tab 3: Financial (conditional) ──
  let financeData = {};
  if (canViewFinance) {
    const portfolio = db.prepare(`
      SELECT
        COALESCE(SUM(b.contract_value + b.variations_approved), 0) as total_contract,
        COALESCE(SUM(ce_total.spent), 0) as total_spent
      FROM job_budgets b
      JOIN jobs j ON b.job_id = j.id AND j.status IN ('active','on_hold','won','completed')
      LEFT JOIN (SELECT job_id, SUM(amount) as spent FROM cost_entries GROUP BY job_id) ce_total ON ce_total.job_id = j.id
    `).get();

    const monthlySpend = db.prepare(`
      SELECT strftime('%Y-%m', entry_date) as month, SUM(amount) as total
      FROM cost_entries
      WHERE entry_date >= date(?, '-5 months')
      GROUP BY month ORDER BY month ASC
    `).all(fromDate);

    const jobFinancials = db.prepare(`
      SELECT j.id, j.job_number, j.client, j.status,
        COALESCE(b.contract_value, 0) as contract_value,
        COALESCE(b.variations_approved, 0) as variations,
        COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) as total_spent
      FROM jobs j LEFT JOIN job_budgets b ON j.id = b.job_id
      WHERE j.status IN ('active','on_hold','won','completed') AND COALESCE(b.contract_value, 0) > 0
      ORDER BY j.job_number
    `).all();

    const spendByCategory = db.prepare(`
      SELECT category, SUM(amount) as total
      FROM cost_entries WHERE entry_date BETWEEN ? AND ?
      GROUP BY category ORDER BY total DESC
    `).all(fromDate, toDate);

    financeData = {
      portfolio,
      monthlySpend,
      jobFinancials,
      spendByCategory,
      overBudgetCount: overBudgetJobs.length
    };
  }

  // ── Tab 4: Safety & Compliance ──
  const incidentsByMonth = db.prepare(`
    SELECT strftime('%Y-%m', incident_date) as month, severity, COUNT(*) as count
    FROM incidents WHERE incident_date BETWEEN ? AND ?
    GROUP BY month, severity ORDER BY month ASC
  `).all(fromDate, toDate);

  const incidentsByType = db.prepare(`
    SELECT incident_type, COUNT(*) as count
    FROM incidents WHERE incident_date BETWEEN ? AND ?
    GROUP BY incident_type ORDER BY count DESC
  `).all(fromDate, toDate);

  const openIncidents = db.prepare(`
    SELECT i.id, i.incident_number, i.title, i.severity, i.incident_date, i.incident_type, i.investigation_status,
      j.job_number
    FROM incidents i LEFT JOIN jobs j ON i.job_id = j.id
    WHERE i.investigation_status NOT IN ('closed','resolved')
    ORDER BY i.incident_date DESC LIMIT 20
  `).all();

  const correctiveStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
      COALESCE(SUM(CASE WHEN due_date < ? AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END), 0) as overdue
    FROM corrective_actions
  `).get(today);

  const overdueCompliance = db.prepare(`
    SELECT c.id, c.title, c.item_type, c.due_date, c.status, j.job_number
    FROM compliance c LEFT JOIN jobs j ON c.job_id = j.id
    WHERE c.status NOT IN ('approved','expired') AND c.due_date < ?
    ORDER BY c.due_date ASC LIMIT 20
  `).all(today);

  const notifiableCount = db.prepare(`
    SELECT COUNT(*) as count FROM incidents
    WHERE notifiable_incident = 1 AND incident_date BETWEEN ? AND ?
  `).get(fromDate, toDate).count;

  // ── Tab 5: Timesheets ──
  const tsOverall = db.prepare(`
    SELECT
      COALESCE(SUM(total_hours), 0) as total_hours,
      COALESCE(SUM(overtime_hours), 0) as overtime_hours,
      COALESCE(SUM(CASE WHEN approved = 0 THEN total_hours ELSE 0 END), 0) as pending_hours,
      COALESCE(SUM(CASE WHEN approved = 1 THEN total_hours ELSE 0 END), 0) as approved_hours,
      COUNT(DISTINCT crew_member_id) as unique_crew
    FROM timesheets WHERE work_date BETWEEN ? AND ?
  `).get(fromDate, toDate);

  const tsByJob = db.prepare(`
    SELECT j.id, j.job_number, j.client,
      SUM(t.total_hours) as total_hours,
      SUM(t.overtime_hours) as overtime,
      COUNT(DISTINCT t.crew_member_id) as crew_count
    FROM timesheets t JOIN jobs j ON t.job_id = j.id
    WHERE t.work_date BETWEEN ? AND ?
    GROUP BY j.id ORDER BY total_hours DESC LIMIT 30
  `).all(fromDate, toDate);

  const tsByCrew = db.prepare(`
    SELECT cm.id, cm.full_name, cm.role,
      SUM(t.total_hours) as total_hours,
      SUM(t.overtime_hours) as overtime,
      COUNT(DISTINCT t.work_date) as days_worked
    FROM timesheets t JOIN crew_members cm ON t.crew_member_id = cm.id
    WHERE t.work_date BETWEEN ? AND ?
    GROUP BY cm.id ORDER BY total_hours DESC LIMIT 30
  `).all(fromDate, toDate);

  const tsWeekly = db.prepare(`
    SELECT strftime('%Y-W%W', work_date) as week,
      SUM(total_hours) as total_hours,
      SUM(COALESCE(ordinary_hours, 0)) as ordinary,
      SUM(overtime_hours) as overtime
    FROM timesheets WHERE work_date BETWEEN ? AND ?
    GROUP BY week ORDER BY week ASC
  `).all(fromDate, toDate);

  res.render('reports/index', {
    title: 'Reports & Analytics',
    currentPage: 'reports',
    jobs,
    fromDate, toDate, activeTab, canViewFinance,
    // Crew
    crewData, dailyAllocations, activeCrew, totalCrewHours,
    avgDaysAllocated: Math.round(avgDaysAllocated * 10) / 10,
    fatigueCount: fatigueRisk.length,
    // Jobs
    jobsByStatus, jobsByHealth, activeJobCount, redHealth,
    overdueJobs, overBudgetJobs, staleJobs,
    // Finance
    financeData,
    // Safety
    incidentsByMonth, incidentsByType, openIncidents,
    correctiveStats, overdueCompliance, notifiableCount,
    // Timesheets
    tsOverall, tsByJob, tsByCrew, tsWeekly
  });
});

module.exports = router;
