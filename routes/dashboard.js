const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');

router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const today = new Date().toISOString().split('T')[0];
  const next14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  // KPI counts
  const activeJobs = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'active'").get().count;
  const startingSoon = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE start_date BETWEEN ? AND ? AND status IN ('won','active')").get(today, next14).count;
  const overdueTasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE due_date < ? AND status != 'complete'").get(today).count;
  const overdueCompliance = db.prepare("SELECT COUNT(*) as count FROM compliance WHERE due_date < ? AND status NOT IN ('approved','expired')").get(today).count;
  const missingUpdates = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE status = 'active' AND (last_update_date IS NULL OR last_update_date < ?)").get(last7).count;

  // Safety KPIs
  const openIncidents = db.prepare("SELECT COUNT(*) as count FROM incidents WHERE investigation_status NOT IN ('closed', 'resolved')").get().count;
  const overdueCorrectiveActions = db.prepare("SELECT COUNT(*) as count FROM corrective_actions WHERE due_date < ? AND status != 'completed'").get(today).count;

  // Ops KPIs
  const crewHoursThisWeek = db.prepare(`
    SELECT COALESCE(SUM(total_hours), 0) as total FROM timesheets
    WHERE work_date >= date('now', '-7 days')
  `).get().total;
  const equipmentDeployed = db.prepare("SELECT COUNT(*) as count FROM equipment_assignments WHERE actual_return_date IS NULL").get().count;
  const openDefects = db.prepare("SELECT COUNT(*) as count FROM defects WHERE status NOT IN ('closed', 'deferred')").get().count;

  // Financial KPIs (accounts/management only)
  let totalContractValue = 0;
  let totalSpend = 0;
  let accountsOverdue = 0;
  let accountsDisputed = 0;
  if (canViewAccounts(user)) {
    accountsOverdue = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE accounts_status = 'overdue'").get().count;
    accountsDisputed = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE accounts_status = 'disputed'").get().count;
    totalContractValue = db.prepare("SELECT COALESCE(SUM(contract_value), 0) as total FROM job_budgets").get().total;
    totalSpend = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries").get().total;
  }

  // My Jobs
  const myJobs = db.prepare(`
    SELECT j.*, u.full_name as pm_name FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status IN ('active','on_hold','won')
    AND (j.project_manager_id = ? OR j.ops_supervisor_id = ? OR j.planning_owner_id = ? OR j.marketing_owner_id = ? OR j.accounts_owner_id = ?)
    ORDER BY CASE j.health WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END, j.start_date DESC
    LIMIT 20
  `).all(user.id, user.id, user.id, user.id, user.id);

  // Jobs needing attention
  const needsAttention = db.prepare(`
    SELECT j.*, u.full_name as pm_name FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status = 'active'
    AND (j.health IN ('red','amber') OR j.last_update_date IS NULL OR j.last_update_date < ?)
    ORDER BY CASE j.health WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END
    LIMIT 15
  `).all(last7);

  // Recent updates
  const recentUpdates = db.prepare(`
    SELECT pu.*, j.job_number, j.client, u.full_name as submitted_by_name
    FROM project_updates pu
    JOIN jobs j ON pu.job_id = j.id
    JOIN users u ON pu.submitted_by_id = u.id
    WHERE pu.week_ending >= ?
    ORDER BY pu.created_at DESC
    LIMIT 10
  `).all(last7);

  // Overdue tasks list
  const overdueTasksList = db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name
    FROM tasks t
    JOIN jobs j ON t.job_id = j.id
    JOIN users u ON t.owner_id = u.id
    WHERE t.due_date < ? AND t.status != 'complete'
    ORDER BY t.due_date ASC
    LIMIT 10
  `).all(today);

  res.render('dashboard', {
    title: 'Dashboard',
    user,
    kpi: {
      activeJobs, startingSoon, overdueTasks, overdueCompliance, missingUpdates,
      openIncidents, overdueCorrectiveActions,
      crewHoursThisWeek, equipmentDeployed, openDefects,
      totalContractValue, totalSpend, accountsOverdue, accountsDisputed
    },
    myJobs,
    needsAttention,
    recentUpdates,
    overdueTasksList,
    canViewAccounts: canViewAccounts(user)
  });
});

module.exports = router;
