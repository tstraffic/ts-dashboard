const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');

router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const today = new Date().toISOString().split('T')[0];
  const next14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
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
  const notifiableIncidents = db.prepare("SELECT COUNT(*) as count FROM incidents WHERE notifiable_incident = 1 AND investigation_status NOT IN ('closed', 'resolved')").get().count;

  // Ops KPIs
  const crewHoursThisWeek = db.prepare(`
    SELECT COALESCE(SUM(total_hours), 0) as total FROM timesheets
    WHERE work_date >= date('now', '-7 days')
  `).get().total;
  const crewDeployedToday = db.prepare("SELECT COUNT(DISTINCT crew_member_id) as count FROM timesheets WHERE work_date = ?").get(today).count;
  const equipmentDeployed = db.prepare("SELECT COUNT(*) as count FROM equipment_assignments WHERE actual_return_date IS NULL").get().count;
  const unconfirmedAllocations = db.prepare("SELECT COUNT(*) as count FROM crew_allocations WHERE allocation_date = ? AND status = 'allocated'").get(today).count;
  const openDefects = db.prepare("SELECT COUNT(*) as count FROM defects WHERE status NOT IN ('closed', 'deferred')").get().count;

  // Approvals KPIs
  const rolPending = db.prepare("SELECT COUNT(*) as count FROM traffic_plans WHERE rol_required = 1 AND (rol_approved IS NULL OR rol_approved = 0) AND status NOT IN ('rejected','expired')").get().count;
  const tmpPending = db.prepare("SELECT COUNT(*) as count FROM traffic_plans WHERE plan_type = 'TMP' AND status NOT IN ('approved','rejected','expired')").get().count;
  const ticketsExpiring = db.prepare(`
    SELECT COUNT(*) as count FROM crew_members WHERE active = 1 AND (
      (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
      OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
      OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
      OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
      OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
    )
  `).get(today, next30, today, next30, today, next30, today, next30, today, next30).count;

  // Financial KPIs (accounts/management only)
  let totalContractValue = 0;
  let totalSpend = 0;
  let accountsOverdue = 0;
  let accountsDisputed = 0;
  let revenueThisMonth = 0;
  if (canViewAccounts(user)) {
    accountsOverdue = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE accounts_status = 'overdue'").get().count;
    accountsDisputed = db.prepare("SELECT COUNT(*) as count FROM jobs WHERE accounts_status = 'disputed'").get().count;
    totalContractValue = db.prepare("SELECT COALESCE(SUM(contract_value), 0) as total FROM job_budgets").get().total;
    totalSpend = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries").get().total;
    revenueThisMonth = db.prepare("SELECT COALESCE(SUM(jb.contract_value), 0) as total FROM job_budgets jb JOIN jobs j ON jb.job_id = j.id WHERE j.status IN ('active','completed')").get().total;
  }

  // Today's allocations
  const todaysAllocations = db.prepare(`
    SELECT ca.*, cm.full_name as crew_name, cm.role as crew_role, j.job_number, j.client, j.site_address
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.allocation_date = ?
    ORDER BY ca.start_time ASC
  `).all(today);

  // Crew availability summary
  const totalActiveCrew = db.prepare("SELECT COUNT(*) as count FROM crew_members WHERE active = 1").get().count;
  const allocatedToday = db.prepare("SELECT COUNT(DISTINCT crew_member_id) as count FROM crew_allocations WHERE allocation_date = ?").get(today).count;
  const availableCrew = totalActiveCrew - allocatedToday;

  // Recent activity log (last 10)
  const recentActivity = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC
    LIMIT 10
  `).all();

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

  // Chart data: job status distribution
  const jobStatusDist = db.prepare(`
    SELECT status, COUNT(*) as count FROM jobs GROUP BY status
  `).all();

  // Chart data: job health distribution
  const jobHealthDist = db.prepare(`
    SELECT health, COUNT(*) as count FROM jobs WHERE status = 'active' GROUP BY health
  `).all();

  // Chart data: crew hours by day (last 7 days)
  const crewHoursByDay = db.prepare(`
    SELECT work_date, COALESCE(SUM(total_hours), 0) as hours
    FROM timesheets
    WHERE work_date >= date('now', '-7 days')
    GROUP BY work_date
    ORDER BY work_date ASC
  `).all();

  // Plans & Approvals — urgent items for dashboard widget
  const complianceUrgent = db.prepare(`
    SELECT c.id, c.title, c.item_type, c.status, c.due_date, c.expiry_date,
      c.council_fee_paid, c.council_fee_amount,
      j.job_number, j.client as job_client,
      cl.company_name as client_name,
      a.full_name as assigned_name
    FROM compliance c
    LEFT JOIN jobs j ON c.job_id = j.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users a ON c.assigned_to_id = a.id
    WHERE (
      (c.due_date IS NOT NULL AND c.due_date <= ? AND c.status NOT IN ('approved','expired'))
      OR (c.due_date IS NOT NULL AND c.due_date > ? AND c.due_date <= ? AND c.status NOT IN ('approved','expired'))
      OR (c.expiry_date IS NOT NULL AND c.expiry_date >= ? AND c.expiry_date <= ? AND c.status = 'approved')
      OR (c.expiry_date IS NOT NULL AND c.expiry_date < ? AND c.status = 'approved')
      OR (c.status IN ('not_started','submitted') AND c.due_date IS NOT NULL)
    )
    ORDER BY
      CASE
        WHEN c.due_date IS NOT NULL AND c.due_date < ? AND c.status NOT IN ('approved','expired') THEN 1
        WHEN c.expiry_date IS NOT NULL AND c.expiry_date < ? THEN 2
        WHEN c.due_date IS NOT NULL AND c.due_date <= ? AND c.status NOT IN ('approved','expired') THEN 3
        WHEN c.expiry_date IS NOT NULL AND c.expiry_date <= ? THEN 4
        ELSE 5
      END,
      COALESCE(c.due_date, c.expiry_date) ASC
    LIMIT 10
  `).all(today, today, next14, today, next30, today, today, today, next14, next30);

  // Action items: things that need immediate attention
  const actionItems = [];
  if (overdueTasks > 0) actionItems.push({ icon: 'task', color: 'red', text: `${overdueTasks} overdue task${overdueTasks !== 1 ? 's' : ''}`, link: '/tasks' });
  if (overdueCompliance > 0) actionItems.push({ icon: 'shield', color: 'red', text: `${overdueCompliance} overdue compliance item${overdueCompliance !== 1 ? 's' : ''}`, link: '/compliance' });
  if (openIncidents > 0) actionItems.push({ icon: 'alert', color: 'red', text: `${openIncidents} open incident${openIncidents !== 1 ? 's' : ''}`, link: '/incidents' });
  if (missingUpdates > 0) actionItems.push({ icon: 'update', color: 'orange', text: `${missingUpdates} job${missingUpdates !== 1 ? 's' : ''} missing weekly update`, link: '/updates' });
  if (unconfirmedAllocations > 0) actionItems.push({ icon: 'crew', color: 'orange', text: `${unconfirmedAllocations} unconfirmed allocation${unconfirmedAllocations !== 1 ? 's' : ''} today`, link: '/allocations' });
  if (ticketsExpiring > 0) actionItems.push({ icon: 'ticket', color: 'orange', text: `${ticketsExpiring} crew ticket${ticketsExpiring !== 1 ? 's' : ''} expiring soon`, link: '/crew' });
  if (openDefects > 0) actionItems.push({ icon: 'defect', color: 'orange', text: `${openDefects} open defect${openDefects !== 1 ? 's' : ''}`, link: '/defects' });

  res.render('dashboard', {
    title: 'Dashboard',
    user,
    kpi: {
      activeJobs, startingSoon, overdueTasks, overdueCompliance, missingUpdates,
      openIncidents, overdueCorrectiveActions, notifiableIncidents,
      crewHoursThisWeek, crewDeployedToday, equipmentDeployed, openDefects, unconfirmedAllocations,
      rolPending, tmpPending, ticketsExpiring,
      totalContractValue, totalSpend, revenueThisMonth, accountsOverdue, accountsDisputed
    },
    myJobs,
    needsAttention,
    recentUpdates,
    overdueTasksList,
    complianceUrgent,
    actionItems,
    jobStatusDist,
    jobHealthDist,
    crewHoursByDay,
    canViewAccounts: canViewAccounts(user),
    todaysAllocations,
    totalActiveCrew,
    allocatedToday,
    availableCrew,
    recentActivity,
    userRole: user.role
  });
});

module.exports = router;
