// Bidirectional close between a corrective action and its linked task.
//
// When a CA is created with an assignee we spawn a task; the CA stores the
// task id. After that, closing either side has to also flip the other so
// the two are never out of sync — the office can tick it off from /tasks
// or from the incident page and end up in the same state.
//
// All helpers are idempotent: re-running them after both sides are already
// complete is a no-op (so we never double-fire diary logs / notifications
// when the close cascades).

const { sydneyToday } = require('./sydney');
const { logStatusChange } = require('./diary');

// Map CA priority ('low'|'medium'|'high'|'critical') onto the task CHECK
// (low|medium|high). 'critical' becomes 'high' — there's no critical bucket
// on tasks and burying it as 'medium' would lose the urgency.
function caPriorityToTaskPriority(p) {
  if (p === 'critical') return 'high';
  if (p === 'low' || p === 'medium' || p === 'high') return p;
  return 'medium';
}

// Create a task that mirrors the CA. Returns the new task id, or null if
// no assignee was supplied (CAs are still allowed to exist unassigned —
// we just skip task creation in that case).
function createLinkedTask(db, ca, incident, user) {
  if (!ca.assigned_to_id) return null;
  const title = `Corrective Action: ${(ca.description || '').substring(0, 100)}`;
  const result = db.prepare(`
    INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes)
    VALUES (?, 'safety', ?, ?, ?, ?, 'not_started', ?, 'one_off', ?)
  `).run(
    ca.job_id,
    title,
    ca.description || '',
    ca.assigned_to_id,
    ca.due_date,
    caPriorityToTaskPriority(ca.priority),
    incident && incident.incident_number ? `Linked to incident ${incident.incident_number}` : ''
  );
  return result.lastInsertRowid;
}

// Mark the task linked to a CA as complete (if any, and if not already
// done). Returns true if a task was actually flipped.
function closeTaskFromCa(db, caId, user) {
  const ca = db.prepare('SELECT id, task_id FROM corrective_actions WHERE id = ?').get(caId);
  if (!ca || !ca.task_id) return false;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(ca.task_id);
  if (!task || task.status === 'complete') return false;
  const today = sydneyToday();
  db.prepare("UPDATE tasks SET status = 'complete', completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(today, ca.task_id);
  if (task.job_id) {
    try {
      logStatusChange(db, {
        jobId: task.job_id, entityType: 'task',
        entityLabel: `Task: ${task.title}`,
        oldStatus: task.status || 'not_started', newStatus: 'complete',
        userId: user ? user.id : null,
        userName: user ? user.full_name : 'System',
      });
    } catch (e) { /* diary failures shouldn't block the close */ }
  }
  return true;
}

// Mark every open CA pointing at this task as completed. Used when a task
// is closed from the tasks list — the user may not realise it came from
// an incident, but the CA needs to follow it.
function closeCasFromTask(db, taskId, user, completionNotes) {
  const cas = db.prepare("SELECT id, incident_id FROM corrective_actions WHERE task_id = ? AND status != 'completed'").all(taskId);
  if (cas.length === 0) return 0;
  const today = sydneyToday();
  const stmt = db.prepare(`
    UPDATE corrective_actions
    SET status = 'completed', completed_date = ?, completion_notes = COALESCE(NULLIF(completion_notes, ''), ?), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  for (const ca of cas) {
    stmt.run(today, completionNotes || 'Closed via linked task.', ca.id);
  }
  return cas.length;
}

module.exports = {
  caPriorityToTaskPriority,
  createLinkedTask,
  closeTaskFromCa,
  closeCasFromTask,
};
