const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const {
  getUrgencyKpis,
  getOpsData,
  getFinanceData,
  getChartData,
  getMyWork,
  getMyTasks,
  getTasksIAssigned,
  getComplianceUrgent,
  getMyPlans,
  getRecentActivity,
} = require('./helpers/dashboard-queries');

router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const today = new Date().toISOString().split('T')[0];

  // Always-needed data
  const urgency = getUrgencyKpis(db, today, req.session.user);
  const ops = getOpsData(db, today);
  const charts = getChartData(db);
  const myWork = getMyWork(db, user, today);
  const myTasks = getMyTasks(db, user, today);
  const tasksIAssigned = getTasksIAssigned(db, user, today);
  const complianceUrgent = getComplianceUrgent(db, today);
  const myPlans = getMyPlans(db, user.id, today);
  const recentActivity = getRecentActivity(db);

  // Finance data (role-gated)
  const finance = canViewAccounts(user) ? getFinanceData(db) : { totalContractValue: 0, totalSpend: 0, accountsOverdue: 0, accountsDisputed: 0 };

  // Jobs needing attention
  const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const needsAttention = db.prepare(`
    SELECT j.*, u.full_name as pm_name FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status = 'active'
    AND (j.health IN ('red','amber') OR j.last_update_date IS NULL OR j.last_update_date < ?)
    ORDER BY CASE j.health WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END
    LIMIT 15
  `).all(last7);

  // Build action items from urgency data
  const actionItems = [];
  if (urgency.overdueTasks > 0) actionItems.push({ icon: 'task', color: 'red', text: `${urgency.overdueTasks} overdue task${urgency.overdueTasks !== 1 ? 's' : ''}`, link: '/tasks' });
  if (urgency.overdueCompliance > 0) actionItems.push({ icon: 'shield', color: 'red', text: `${urgency.overdueCompliance} overdue compliance item${urgency.overdueCompliance !== 1 ? 's' : ''}`, link: '/compliance' });
  if (urgency.openIncidents > 0) actionItems.push({ icon: 'alert', color: 'red', text: `${urgency.openIncidents} open incident${urgency.openIncidents !== 1 ? 's' : ''}`, link: '/incidents' });
  if (urgency.missingUpdates > 0) actionItems.push({ icon: 'update', color: 'orange', text: `${urgency.missingUpdates} job${urgency.missingUpdates !== 1 ? 's' : ''} missing weekly update`, link: '/jobs?status=active' });
  if (urgency.unconfirmedAllocations > 0) actionItems.push({ icon: 'crew', color: 'orange', text: `${urgency.unconfirmedAllocations} unconfirmed allocation${urgency.unconfirmedAllocations !== 1 ? 's' : ''} today`, link: '/allocations' });
  if (urgency.ticketsExpiring > 0) actionItems.push({ icon: 'ticket', color: 'orange', text: `${urgency.ticketsExpiring} crew ticket${urgency.ticketsExpiring !== 1 ? 's' : ''} expiring soon`, link: '/crew' });
  if (urgency.openDefects > 0) actionItems.push({ icon: 'defect', color: 'orange', text: `${urgency.openDefects} open defect${urgency.openDefects !== 1 ? 's' : ''}`, link: '/defects' });
  if (urgency.pendingTimesheets > 0) actionItems.push({ icon: 'clock', color: 'orange', text: `${urgency.pendingTimesheets} pending timesheet${urgency.pendingTimesheets !== 1 ? 's' : ''}`, link: '/timesheets?approved=0' });
  if (urgency.crewGaps > 0) actionItems.push({ icon: 'crew', color: 'red', text: `${urgency.crewGaps} crew gap${urgency.crewGaps !== 1 ? 's' : ''} today`, link: '/allocations' });

  // Onboarding checklist
  let onboarding = null;
  try {
    const prefs = JSON.parse(db.prepare('SELECT preferences FROM users WHERE id = ?').get(user.id)?.preferences || '{}');
    if (!prefs.onboarding_dismissed) {
      const isAdmin = user.role === 'admin';
      const checks = [];
      checks.push({ key: 'profile', label: 'Update your profile', link: '/profile', done: !!user.email });
      if (isAdmin) {
        const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const jobCount = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
        const crewCount = db.prepare("SELECT COUNT(*) as c FROM crew_members").get().c;
        checks.push({ key: 'users', label: 'Add a team member', link: '/admin/users', done: userCount > 1 });
        checks.push({ key: 'job', label: 'Create first job', link: '/jobs/new', done: jobCount > 0 });
        checks.push({ key: 'crew', label: 'Add crew member', link: '/crew/new', done: crewCount > 0 });
        checks.push({ key: 'settings', label: 'Configure dropdowns', link: '/settings', done: false });
      }
      checks.push({ key: 'notifications', label: 'Enable push notifications', link: '/profile', done: false });
      const allDone = checks.every(c => c.done);
      if (!allDone) onboarding = checks;
    }
  } catch (e) { /* preferences column may not exist yet */ }

  res.render('dashboard', {
    title: 'Dashboard',
    user,
    onboarding,
    kpi: {
      activeJobs: ops.activeJobs,
      startingSoon: ops.startingSoon,
      crewHoursThisWeek: ops.crewHoursThisWeek,
      equipmentDeployed: ops.equipmentDeployed,
      rolPending: ops.rolPending,
      tmpPending: ops.tmpPending,
      ...urgency,
      ...finance,
    },
    myJobs: myWork.myJobs,
    needsAttention,
    recentUpdates: myWork.recentUpdates,
    overdueTasksList: myWork.overdueTasksList,
    complianceUrgent,
    actionItems,
    jobStatusDist: charts.jobStatusDist,
    jobHealthDist: charts.jobHealthDist,
    crewHoursByDay: charts.crewHoursByDay,
    canViewAccounts: canViewAccounts(user),
    todaysAllocations: ops.todaysAllocations,
    totalActiveCrew: ops.totalActiveCrew,
    allocatedToday: ops.allocatedToday,
    availableCrew: ops.availableCrew,
    recentActivity,
    myTasks,
    myPlans,
    tasksIAssigned,
    userRole: user.role,
  });
});

module.exports = router;
