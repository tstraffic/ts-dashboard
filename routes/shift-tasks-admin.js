// Operations Tasks Board. Lets office staff allocate tasks to any
// crew member, either bound to a specific booking ("this shift only")
// or general ("standing task they carry across shifts"). The same
// shift_tasks table powers the per-booking card on bookings/show.ejs;
// this view is a global counterpart filterable by status / assignee.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// GET /shift-tasks — board view
router.get('/', (req, res) => {
  const db = getDb();
  const status = (req.query.status || 'pending').trim();   // pending | done | cancelled | all
  const scope = (req.query.scope || 'all').trim();          // all | shift | general
  const assignee = req.query.assignee ? Number(req.query.assignee) : null;

  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('st.status = ?'); params.push(status); }
  if (scope === 'shift')   { where.push('st.booking_id IS NOT NULL'); }
  if (scope === 'general') { where.push('st.booking_id IS NULL AND st.allocation_id IS NULL'); }
  if (assignee)            { where.push('st.crew_member_id = ?'); params.push(assignee); }

  const rows = db.prepare(`
    SELECT st.*,
      cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
      b.booking_number, b.title AS booking_title, b.start_datetime,
      u.full_name AS created_by_name,
      cb.full_name AS created_by_crew_name
    FROM shift_tasks st
    JOIN crew_members cm ON st.crew_member_id = cm.id
    LEFT JOIN bookings b ON st.booking_id = b.id
    LEFT JOIN users u ON st.created_by_user_id = u.id
    LEFT JOIN crew_members cb ON st.created_by_crew_id = cb.id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
             st.due_at ASC, st.created_at DESC
    LIMIT 200
  `).all(...params);

  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE status='pending'").get().c,
    done:    db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE status='done'").get().c,
    general: db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE booking_id IS NULL AND allocation_id IS NULL").get().c,
  };

  // Form data — active crew + upcoming/recent bookings, so the create
  // panel doesn't hit the DB on every dropdown render.
  const crew = db.prepare("SELECT id, full_name, portal_role FROM crew_members WHERE active = 1 ORDER BY portal_role DESC, full_name ASC").all();
  let bookings = [];
  try {
    bookings = db.prepare(`
      SELECT id, booking_number, title, start_datetime
      FROM bookings
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled','late_cancellation','complete','finalised')
        AND date(start_datetime) >= date('now','-1 day')
      ORDER BY start_datetime ASC LIMIT 100
    `).all();
  } catch (e) { /* legacy DB */ }

  res.render('shift-tasks/index', {
    title: 'Tasks Board',
    rows, counts, status, scope, assignee, crew, bookings,
  });
});

// POST /shift-tasks — create
router.post('/', (req, res) => {
  const db = getDb();
  const { crew_member_id, scope, booking_id, title, description, priority, due_at } = req.body;
  if (!crew_member_id || !title || !title.trim()) {
    req.flash('error', 'Title and assignee are required.');
    return res.redirect('/shift-tasks');
  }
  let bookingScope = null, allocScope = null;
  if (scope !== 'general') {
    if (!booking_id) {
      req.flash('error', 'Pick a shift, or mark the task as general.');
      return res.redirect('/shift-tasks');
    }
    // Assignee must be on this booking — block cross-booking task drops.
    const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(booking_id, crew_member_id);
    if (!ok) {
      req.flash('error', "Worker isn't assigned to that booking.");
      return res.redirect('/shift-tasks');
    }
    bookingScope = booking_id;
    const alloc = db.prepare("SELECT id FROM crew_allocations WHERE booking_id=? AND crew_member_id=? LIMIT 1").get(booking_id, crew_member_id);
    if (alloc) allocScope = alloc.id;
  }
  db.prepare(`
    INSERT INTO shift_tasks (allocation_id, booking_id, crew_member_id, title, description, priority, due_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    allocScope, bookingScope, crew_member_id, title.trim(), (description || '').trim(),
    ['low','normal','high'].includes(priority) ? priority : 'normal',
    due_at || null, req.session.user.id
  );
  logActivity({ user: req.session.user, action: 'create', entityType: 'shift_task', details: 'Created task: ' + title.trim(), req });
  req.flash('success', scope === 'general' ? 'General task created.' : 'Shift task created.');
  res.redirect('/shift-tasks');
});

// POST /shift-tasks/:id/status — toggle / set status
router.post('/:id/status', (req, res) => {
  const status = ['pending','done','cancelled'].includes(req.body.status) ? req.body.status : 'pending';
  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  getDb().prepare(`
    UPDATE shift_tasks
    SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, req.params.id);
  res.redirect('/shift-tasks?status=' + (req.body.return_status || 'pending'));
});

// POST /shift-tasks/:id/delete
router.post('/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM shift_tasks WHERE id = ?').run(req.params.id);
  req.flash('success', 'Task removed.');
  res.redirect('/shift-tasks?status=' + (req.body.return_status || 'pending'));
});

module.exports = router;
