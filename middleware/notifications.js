const { getDb } = require('../db/database');

/**
 * Middleware that attaches unread notification count to res.locals for the header bell icon.
 * Used globally so every page can display the notification badge.
 */
function notificationCountMiddleware(req, res, next) {
  if (!req.session || !req.session.user) return next();

  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id);
    res.locals.unreadNotifications = count ? count.count : 0;
  } catch (err) {
    res.locals.unreadNotifications = 0;
  }

  next();
}

/**
 * Generate automatic notifications (call periodically or on server start).
 * Checks for overdue tasks, expiring compliance, missing updates, etc.
 * Uses de-duplication to avoid sending the same notification within 24 hours.
 */
function generateNotifications() {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const next3 = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

    // Helper: create notification if one with the same user+type+title does not already exist within 24hrs
    const insertIfNew = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link, job_id)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = ? AND type = ? AND title = ? AND created_at > datetime('now', '-1 day')
      )
    `);

    // 1. Overdue tasks --> notify task owner
    const overdueTasks = db.prepare(`
      SELECT t.id, t.title, t.owner_id, t.job_id, j.job_number
      FROM tasks t JOIN jobs j ON t.job_id = j.id
      WHERE t.due_date < ? AND t.status != 'complete'
      AND t.owner_id IS NOT NULL
    `).all(today);

    for (const t of overdueTasks) {
      const title = 'Overdue Task: ' + t.title;
      insertIfNew.run(t.owner_id, 'overdue_task', title, 'Task "' + t.title + '" on ' + t.job_number + ' is overdue.', '/jobs/' + t.job_id + '#tasks', t.job_id, t.owner_id, 'overdue_task', title);
    }

    // 2. Expiring compliance --> notify internal approver or PM
    const expiringCompliance = db.prepare(`
      SELECT c.id, c.title, c.job_id, c.internal_approver_id, j.job_number, j.project_manager_id
      FROM compliance c JOIN jobs j ON c.job_id = j.id
      WHERE c.due_date BETWEEN ? AND ? AND c.status NOT IN ('approved', 'expired')
    `).all(today, next3);

    for (const c of expiringCompliance) {
      const userId = c.internal_approver_id || c.project_manager_id;
      if (!userId) continue;
      const title = 'Compliance Due: ' + c.title;
      insertIfNew.run(userId, 'expiring_compliance', title, c.title + ' on ' + c.job_number + ' is due soon.', '/jobs/' + c.job_id + '#compliance', c.job_id, userId, 'expiring_compliance', title);
    }

    // 3. Missing updates --> notify PM (no update in 7+ days)
    const missingUpdates = db.prepare(`
      SELECT j.id, j.job_number, j.project_manager_id
      FROM jobs j
      WHERE j.status = 'active' AND j.project_manager_id IS NOT NULL
      AND (j.last_update_date IS NULL OR j.last_update_date < ?)
    `).all(last7);

    for (const j of missingUpdates) {
      const title = 'Missing Update: ' + j.job_number;
      insertIfNew.run(j.project_manager_id, 'missing_update', title, j.job_number + ' has no update in the last 7 days.', '/updates/new?job_id=' + j.id, j.id, j.project_manager_id, 'missing_update', title);
    }

    // 4. Overdue corrective actions
    const overdueCA = db.prepare(`
      SELECT ca.id, ca.description, ca.assigned_to_id, ca.job_id, j.job_number, i.incident_number
      FROM corrective_actions ca
      JOIN incidents i ON ca.incident_id = i.id
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.due_date < ? AND ca.status NOT IN ('completed', 'cancelled')
      AND ca.assigned_to_id IS NOT NULL
    `).all(today);

    for (const ca of overdueCA) {
      const title = 'Corrective Action Overdue: ' + ca.incident_number;
      insertIfNew.run(ca.assigned_to_id, 'corrective_action_due', title, 'Action for ' + ca.incident_number + ' is overdue.', '/incidents/' + ca.id, ca.job_id, ca.assigned_to_id, 'corrective_action_due', title);
    }

    // 5. Follow-ups due
    const followUps = db.prepare(`
      SELECT cl.id, cl.subject, cl.logged_by_id, cl.job_id, j.job_number
      FROM communication_log cl
      JOIN jobs j ON cl.job_id = j.id
      WHERE cl.follow_up_required = 1 AND cl.follow_up_done = 0
      AND cl.follow_up_date <= ?
      AND cl.logged_by_id IS NOT NULL
    `).all(today);

    for (const f of followUps) {
      const title = 'Follow-up Due: ' + f.subject;
      insertIfNew.run(f.logged_by_id, 'follow_up_due', title, 'Follow-up for "' + f.subject + '" on ' + f.job_number + ' is due.', '/contacts/comms?job_id=' + f.job_id, f.job_id, f.logged_by_id, 'follow_up_due', title);
    }

    // 6. Equipment overdue return
    const overdueEquip = db.prepare(`
      SELECT ea.id, ea.equipment_id, ea.job_id, ea.assigned_by_id, e.asset_number, e.name, j.job_number
      FROM equipment_assignments ea
      JOIN equipment e ON ea.equipment_id = e.id
      JOIN jobs j ON ea.job_id = j.id
      WHERE ea.expected_return_date < ? AND ea.actual_return_date IS NULL
      AND ea.assigned_by_id IS NOT NULL
    `).all(today);

    for (const eq of overdueEquip) {
      const title = 'Equipment Overdue: ' + eq.asset_number;
      insertIfNew.run(eq.assigned_by_id, 'equipment_overdue', title, eq.asset_number + ' (' + eq.name + ') overdue for return from ' + eq.job_number + '.', '/equipment/' + eq.equipment_id, eq.job_id, eq.assigned_by_id, 'equipment_overdue', title);
    }

    // 7. Critical defects --> notify management users
    const criticalDefects = db.prepare(`
      SELECT d.id, d.defect_number, d.title, d.job_id, j.job_number
      FROM defects d
      JOIN jobs j ON d.job_id = j.id
      WHERE d.severity = 'critical' AND d.status NOT IN ('closed', 'deferred')
    `).all();

    const mgmtUsers = db.prepare("SELECT id FROM users WHERE role = 'management' AND active = 1").all();
    for (const d of criticalDefects) {
      for (const u of mgmtUsers) {
        const title = 'Critical Defect: ' + d.defect_number;
        insertIfNew.run(u.id, 'critical_defect', title, d.defect_number + ': ' + d.title + ' on ' + d.job_number, '/defects/' + d.id, d.job_id, u.id, 'critical_defect', title);
      }
    }

  } catch (err) {
    console.error('Notification generation error:', err.message);
  }
}

module.exports = { notificationCountMiddleware, generateNotifications };
