/**
 * Auto-create site diary entry when something changes on a job.
 * Silently skips if no jobId is provided (diary requires a job).
 *
 * @param {object} db
 * @param {object} opts
 * @param {number} opts.jobId - Job ID (required)
 * @param {string} [opts.category] - Diary task category (default: 'Plans & Approvals Update')
 * @param {string} opts.summary - Description of what happened (goes into outcomes)
 * @param {number} [opts.complianceItemId] - Optional compliance item link
 * @param {number} [opts.userId] - User who triggered the change
 */
function autoLogDiary(db, { jobId, category, complianceItemId, summary, userId }) {
  if (!jobId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO site_diary_entries (job_id, entry_date, task, outcomes, compliance_item_id, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, today, category || 'Plans & Approvals Update', summary, complianceItemId || null, userId || null);
  } catch (e) {
    console.error('[AutoDiary] Error:', e.message);
  }
}

/**
 * Log a status change: auto-logs to site diary AND creates in-app notifications
 * for relevant users on the job (PM, planning owner, ops supervisor, task owner).
 *
 * @param {object} db - Database instance
 * @param {object} opts
 * @param {number} opts.jobId - Job ID
 * @param {string} opts.entityType - 'compliance', 'plan', 'task'
 * @param {string} opts.entityLabel - e.g. "TGS TSTGS-0001-01" or "Task: Fix lane widths"
 * @param {string} opts.oldStatus - Previous status
 * @param {string} opts.newStatus - New status
 * @param {number} opts.userId - User who made the change
 * @param {string} opts.userName - Display name of user
 */
function logStatusChange(db, { jobId, entityType, entityLabel, oldStatus, newStatus, userId, userName }) {
  if (!jobId || oldStatus === newStatus) return;

  const oldLabel = (oldStatus || 'not_started').replace(/_/g, ' ');
  const newLabel = (newStatus || '').replace(/_/g, ' ');
  const summary = `${entityLabel}: ${oldLabel} → ${newLabel} (by ${userName || 'System'})`;

  // 1. Auto-log to site diary
  autoLogDiary(db, { jobId, summary, userId });

  // 2. Create in-app notification for relevant users on this job
  try {
    const job = db.prepare('SELECT project_manager_id, ops_supervisor_id, planning_owner_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) return;

    // Collect unique user IDs to notify (exclude the person who made the change)
    const notifyIds = new Set();
    if (job.project_manager_id) notifyIds.add(job.project_manager_id);
    if (job.ops_supervisor_id) notifyIds.add(job.ops_supervisor_id);
    if (job.planning_owner_id) notifyIds.add(job.planning_owner_id);
    notifyIds.delete(userId); // don't notify yourself

    if (notifyIds.size === 0) return;

    const jobInfo = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(jobId);
    const title = `${entityLabel} — ${newLabel}`;
    const message = `${userName || 'Someone'} changed status from ${oldLabel} to ${newLabel} on job ${jobInfo ? jobInfo.job_number : jobId}`;
    const link = `/jobs/${jobId}`;

    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link, job_id)
      SELECT ?, 'general', ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications WHERE user_id = ? AND type = 'general' AND title = ? AND created_at > datetime('now', '-1 hour')
      )
    `);

    for (const uid of notifyIds) {
      try { insertNotif.run(uid, title, message, link, jobId, uid, title); } catch (e) { /* skip */ }
    }
  } catch (e) {
    console.error('[StatusChange] Notification error:', e.message);
  }
}

module.exports = { autoLogDiary, logStatusChange };
