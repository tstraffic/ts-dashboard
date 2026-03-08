const { getDb } = require('../db/database');
const { sendTeamsNotification } = require('./integrations');

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
    const next14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

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
    `).all(today, next14);

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
      const msg = 'Action for ' + ca.incident_number + ' is overdue.';
      const link = '/incidents/' + ca.id;
      const result = insertIfNew.run(ca.assigned_to_id, 'corrective_action_due', title, msg, link, ca.job_id, ca.assigned_to_id, 'corrective_action_due', title);
      if (result.changes > 0) sendTeamsNotification(title, msg, link).catch(() => {});
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
      const msg = eq.asset_number + ' (' + eq.name + ') overdue for return from ' + eq.job_number + '.';
      const link = '/equipment/' + eq.equipment_id;
      const result = insertIfNew.run(eq.assigned_by_id, 'equipment_overdue', title, msg, link, eq.job_id, eq.assigned_by_id, 'equipment_overdue', title);
      if (result.changes > 0) sendTeamsNotification(title, msg, link).catch(() => {});
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
      let teamsNotified = false;
      for (const u of mgmtUsers) {
        const title = 'Critical Defect: ' + d.defect_number;
        const msg = d.defect_number + ': ' + d.title + ' on ' + d.job_number;
        const link = '/defects/' + d.id;
        const result = insertIfNew.run(u.id, 'critical_defect', title, msg, link, d.job_id, u.id, 'critical_defect', title);
        if (result.changes > 0 && !teamsNotified) {
          sendTeamsNotification(title, msg, link).catch(() => {});
          teamsNotified = true; // Only send once per defect, not per user
        }
      }
    }

    // 8. Ticket Expiry --> notify management (30-day warning for crew member tickets)
    const expiringTickets = db.prepare(`
      SELECT cm.id, cm.full_name, cm.tc_ticket_expiry, cm.ti_ticket_expiry, cm.white_card_expiry, cm.first_aid_expiry, cm.medical_expiry
      FROM crew_members cm
      WHERE cm.active = 1
      AND (
        (cm.tc_ticket_expiry IS NOT NULL AND cm.tc_ticket_expiry BETWEEN ? AND ?)
        OR (cm.ti_ticket_expiry IS NOT NULL AND cm.ti_ticket_expiry BETWEEN ? AND ?)
        OR (cm.white_card_expiry IS NOT NULL AND cm.white_card_expiry BETWEEN ? AND ?)
        OR (cm.first_aid_expiry IS NOT NULL AND cm.first_aid_expiry BETWEEN ? AND ?)
        OR (cm.medical_expiry IS NOT NULL AND cm.medical_expiry BETWEEN ? AND ?)
      )
    `).all(today, next30, today, next30, today, next30, today, next30, today, next30);

    for (const cm of expiringTickets) {
      const expiring = [];
      if (cm.tc_ticket_expiry && cm.tc_ticket_expiry >= today && cm.tc_ticket_expiry <= next30) expiring.push('TC Ticket');
      if (cm.ti_ticket_expiry && cm.ti_ticket_expiry >= today && cm.ti_ticket_expiry <= next30) expiring.push('TI Ticket');
      if (cm.white_card_expiry && cm.white_card_expiry >= today && cm.white_card_expiry <= next30) expiring.push('White Card');
      if (cm.first_aid_expiry && cm.first_aid_expiry >= today && cm.first_aid_expiry <= next30) expiring.push('First Aid');
      if (cm.medical_expiry && cm.medical_expiry >= today && cm.medical_expiry <= next30) expiring.push('Medical');
      const ticketList = expiring.join(', ');
      for (const u of mgmtUsers) {
        const title = 'Ticket Expiry: ' + cm.full_name;
        insertIfNew.run(u.id, 'ticket_expiry', title, cm.full_name + ' has expiring tickets: ' + ticketList + '.', '/crew/' + cm.id, null, u.id, 'ticket_expiry', title);
      }
    }

    // 9. ROL Pending --> notify PM
    const rolPending = db.prepare(`
      SELECT tp.id, tp.plan_number, tp.job_id, j.job_number, j.project_manager_id
      FROM traffic_plans tp
      JOIN jobs j ON tp.job_id = j.id
      WHERE tp.rol_required = 1 AND (tp.rol_submitted IS NULL OR tp.rol_submitted = 0)
      AND tp.status NOT IN ('approved','rejected','expired')
      AND j.project_manager_id IS NOT NULL
    `).all();

    for (const rp of rolPending) {
      const title = 'ROL Pending: ' + rp.plan_number;
      insertIfNew.run(rp.project_manager_id, 'rol_pending', title, 'ROL not yet submitted for plan ' + rp.plan_number + ' on ' + rp.job_number + '.', '/jobs/' + rp.job_id + '#traffic-plans', rp.job_id, rp.project_manager_id, 'rol_pending', title);
    }

    // 10. Equipment Inspection Due --> notify management (14-day warning)
    const equipInspectionDue = db.prepare(`
      SELECT e.id, e.asset_number, e.name, e.next_inspection_date
      FROM equipment e
      WHERE e.active = 1 AND e.next_inspection_date BETWEEN ? AND ?
    `).all(today, next14);

    for (const e of equipInspectionDue) {
      for (const u of mgmtUsers) {
        const title = 'Inspection Due: ' + e.asset_number;
        insertIfNew.run(u.id, 'equipment_inspection_due', title, e.asset_number + ' (' + e.name + ') inspection due by ' + e.next_inspection_date + '.', '/equipment/' + e.id, null, u.id, 'equipment_inspection_due', title);
      }
    }

    // 11. Induction Overdue --> notify management
    const inductionOverdue = db.prepare(`
      SELECT cm.id, cm.full_name
      FROM crew_members cm
      WHERE cm.active = 1 AND cm.induction_status = 'pending'
    `).all();

    for (const cm of inductionOverdue) {
      for (const u of mgmtUsers) {
        const title = 'Induction Overdue: ' + cm.full_name;
        insertIfNew.run(u.id, 'induction_overdue', title, cm.full_name + ' has a pending induction.', '/crew/' + cm.id, null, u.id, 'induction_overdue', title);
      }
    }

    // 12. Over-budget jobs --> notify management
    const overBudgetJobs = db.prepare(`
      SELECT j.id, j.job_number, j.project_manager_id, b.contract_value,
        COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) as total_spent
      FROM jobs j
      JOIN job_budgets b ON j.id = b.job_id
      WHERE j.status = 'active'
      AND COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) > b.contract_value
      AND b.contract_value > 0
    `).all();

    for (const ob of overBudgetJobs) {
      let teamsNotified = false;
      for (const u of mgmtUsers) {
        const title = 'Over Budget: ' + ob.job_number;
        const msg = ob.job_number + ' has exceeded its contract value. Spent: $' + Math.round(ob.total_spent) + ' / Contract: $' + Math.round(ob.contract_value) + '.';
        const link = '/budgets/job/' + ob.id;
        const result = insertIfNew.run(u.id, 'over_budget', title, msg, link, ob.id, u.id, 'over_budget', title);
        if (result.changes > 0 && !teamsNotified) {
          sendTeamsNotification(title, msg, link).catch(() => {});
          teamsNotified = true;
        }
      }
    }

  } catch (err) {
    console.error('Notification generation error:', err.message);
  }
}

module.exports = { notificationCountMiddleware, generateNotifications };
