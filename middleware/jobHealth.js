/**
 * Auto-calculate job health based on overdue tasks, compliance, and other signals.
 *
 * Health rules:
 *   RED    — any overdue tasks or overdue compliance (not_started/started past due)
 *          — job end_date is past and status still active
 *   AMBER  — pending tasks > 5 or pending compliance > 3 (backlog building)
 *          — accounts_status is overdue or disputed
 *   GREEN  — everything clear
 */

function recalculateJobHealth(db, jobId) {
  const today = new Date().toISOString().split('T')[0];

  const stats = db.prepare(`
    SELECT
      j.status, j.end_date, j.accounts_status,
      (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < ?) as overdue_tasks,
      (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired','submitted') AND c.due_date IS NOT NULL AND c.due_date < ?) as overdue_compliance,
      (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL) as pending_tasks,
      (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired')) as pending_plans
    FROM jobs j WHERE j.id = ?
  `).get(today, today, jobId);

  if (!stats) return 'green';

  // RED conditions
  if (stats.overdue_tasks > 0 || stats.overdue_compliance > 0) {
    updateHealth(db, jobId, 'red');
    return 'red';
  }
  if (stats.end_date && stats.end_date < today && stats.status === 'active') {
    updateHealth(db, jobId, 'red');
    return 'red';
  }

  // AMBER conditions
  if (stats.pending_tasks > 5 || stats.pending_plans > 3) {
    updateHealth(db, jobId, 'amber');
    return 'amber';
  }
  if (stats.accounts_status === 'overdue' || stats.accounts_status === 'disputed') {
    updateHealth(db, jobId, 'amber');
    return 'amber';
  }

  // GREEN
  updateHealth(db, jobId, 'green');
  return 'green';
}

function updateHealth(db, jobId, health) {
  try {
    db.prepare('UPDATE jobs SET health = ? WHERE id = ? AND health != ?').run(health, jobId, health);
  } catch (e) {
    // Silently fail — health update is non-critical
  }
}

/**
 * Inline SQL CASE expression for list queries.
 * Use as a column alias: `${HEALTH_CALC_SQL} as calculated_health`
 * Requires the subquery aliases: overdue_tasks, overdue_compliance, pending_tasks, pending_plans
 */
const HEALTH_CALC_SQL = `CASE
  WHEN (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL AND t.due_date IS NOT NULL AND t.due_date < date('now')) > 0
    OR (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired','submitted') AND c.due_date IS NOT NULL AND c.due_date < date('now')) > 0
    THEN 'red'
  WHEN j.end_date IS NOT NULL AND j.end_date < date('now') AND j.status = 'active'
    THEN 'red'
  WHEN (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL) > 5
    OR (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired')) > 3
    THEN 'amber'
  WHEN j.accounts_status IN ('overdue','disputed')
    THEN 'amber'
  ELSE 'green'
END`;

module.exports = { recalculateJobHealth, HEALTH_CALC_SQL };
