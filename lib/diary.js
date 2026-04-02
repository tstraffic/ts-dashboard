/**
 * Auto-create site diary entry when something changes on a job.
 * Silently skips if no jobId is provided (diary requires a job).
 */
function autoLogDiary(db, { jobId, complianceItemId, summary, userId }) {
  if (!jobId) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`
      INSERT INTO site_diary_entries (job_id, entry_date, task, outcomes, compliance_item_id, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jobId, today, 'Plans & Approvals Update', summary, complianceItemId || null, userId || null);
  } catch (e) {
    console.error('[AutoDiary] Error:', e.message);
  }
}

module.exports = { autoLogDiary };
