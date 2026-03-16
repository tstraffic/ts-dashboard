const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { sendTaskAssignmentEmail, sendTaskStatusEmail } = require('../middleware/email');

// GET / — Main tasks view with tabs, counts, and filters
router.get('/', (req, res) => {
  const db = getDb();
  const { tab, owner, priority, division, job_id, task_type, view } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const activeView = view || 'all';

  // Build WHERE clause for tab filter
  let baseWhere = '1=1';
  const params = [];

  if (tab === 'not_started') { baseWhere += " AND t.status = 'not_started'"; }
  else if (tab === 'in_progress') { baseWhere += " AND t.status = 'in_progress'"; }
  else if (tab === 'blocked') { baseWhere += " AND t.status = 'blocked'"; }
  else if (tab === 'completed') { baseWhere += " AND t.status = 'complete'"; }

  // View-based date filtering
  if (activeView === 'today') {
    baseWhere += ' AND t.due_date = ?';
    params.push(today);
  } else if (activeView === 'week') {
    const todayDate = new Date(today + 'T00:00:00');
    const dayOfWeek = todayDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(todayDate); monday.setDate(todayDate.getDate() + mondayOffset);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    baseWhere += ' AND t.due_date BETWEEN ? AND ?';
    params.push(monday.toISOString().split('T')[0], sunday.toISOString().split('T')[0]);
  }

  // Additional filters
  if (owner === 'me') { baseWhere += ' AND t.owner_id = ?'; params.push(req.session.user.id); }
  else if (owner && owner !== 'all') { baseWhere += ' AND t.owner_id = ?'; params.push(owner); }
  if (priority && priority !== 'all') { baseWhere += ' AND t.priority = ?'; params.push(priority); }
  if (division && division !== 'all') { baseWhere += ' AND t.division = ?'; params.push(division); }
  if (job_id) { baseWhere += ' AND t.job_id = ?'; params.push(job_id); }
  if (task_type && task_type !== 'all') { baseWhere += ' AND t.task_type = ?'; params.push(task_type); }

  // Fetch tasks
  const tasks = db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name
    FROM tasks t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE ${baseWhere}
    ORDER BY
      CASE WHEN t.status != 'complete' AND t.due_date < '${today}' THEN 0 ELSE 1 END,
      t.due_date ASC,
      CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
  `).all(...params);

  // Status counts (ignoring tab filter but respecting view + other filters)
  let countWhere = '1=1';
  const countParams = [];
  if (activeView === 'today') {
    countWhere += ' AND t.due_date = ?'; countParams.push(today);
  } else if (activeView === 'week') {
    const todayDate2 = new Date(today + 'T00:00:00');
    const dow2 = todayDate2.getDay();
    const mOff2 = dow2 === 0 ? -6 : 1 - dow2;
    const mon2 = new Date(todayDate2); mon2.setDate(todayDate2.getDate() + mOff2);
    const sun2 = new Date(mon2); sun2.setDate(mon2.getDate() + 6);
    countWhere += ' AND t.due_date BETWEEN ? AND ?';
    countParams.push(mon2.toISOString().split('T')[0], sun2.toISOString().split('T')[0]);
  }
  if (owner === 'me') { countWhere += ' AND t.owner_id = ?'; countParams.push(req.session.user.id); }
  else if (owner && owner !== 'all') { countWhere += ' AND t.owner_id = ?'; countParams.push(owner); }
  if (priority && priority !== 'all') { countWhere += ' AND t.priority = ?'; countParams.push(priority); }
  if (division && division !== 'all') { countWhere += ' AND t.division = ?'; countParams.push(division); }
  if (job_id) { countWhere += ' AND t.job_id = ?'; countParams.push(job_id); }
  if (task_type && task_type !== 'all') { countWhere += ' AND t.task_type = ?'; countParams.push(task_type); }

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN t.status = 'not_started' THEN 1 ELSE 0 END) as not_started,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) as complete,
      SUM(CASE WHEN t.status != 'complete' AND t.due_date < '${today}' THEN 1 ELSE 0 END) as overdue
    FROM tasks t WHERE ${countWhere}
  `).get(...countParams);

  // Reference data
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();

  res.render('tasks/index', {
    title: 'Tasks & Actions',
    tasks,
    jobs,
    users,
    counts: counts || { total: 0, not_started: 0, in_progress: 0, blocked: 0, complete: 0, overdue: 0 },
    today,
    filters: req.query,
    activeView,
    user: req.session.user,
  });
});

// GET /new — Create form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('tasks/form', { title: 'New Task', task: null, jobs, users, user: req.session.user, prefillJobId: req.query.job_id || '' });
});

// POST / — Create task
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const jobId = b.job_id || null;
    const division = b.division || 'ops';
    const result = db.prepare(`
      INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, division, b.title, b.description || '', b.owner_id, b.due_date,
      b.status || 'not_started', b.priority || 'medium', b.task_type || 'one_off', b.notes || '');

    // Send email notification to assigned owner (fire-and-forget)
    if (b.owner_id) {
      try {
        const newTaskId = result.lastInsertRowid;
        const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(b.owner_id);
        const job = jobId ? db.prepare('SELECT job_number, client FROM jobs WHERE id = ?').get(jobId) : null;
        const jobLabel = job ? `${job.job_number} - ${job.client}` : 'General';
        const assignedByName = req.session.user ? req.session.user.full_name : '';
        const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const taskData = { id: newTaskId, title: b.title, description: b.description || '', due_date: b.due_date, priority: b.priority || 'medium', task_type: b.task_type || 'one_off' };
        sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
      } catch (emailErr) {
        console.error('[Tasks] Email send error on create:', emailErr.message);
      }
    }

    req.flash('success', 'Task created.');
    res.redirect(b.return_to || '/tasks');
  } catch (err) {
    console.error('[Tasks] Create error:', err.message, err.stack);
    req.flash('error', 'Failed to create task: ' + err.message);
    res.redirect('/tasks/new');
  }
});

// GET /:id/edit — Edit form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) { req.flash('error', 'Task not found.'); return res.redirect('/tasks'); }
  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('tasks/form', { title: 'Edit Task', task, jobs, users, user: req.session.user, prefillJobId: '' });
});

// POST /:id — Update task
router.post('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;

    // Check if owner changed (for email notification)
    const oldTask = db.prepare('SELECT owner_id FROM tasks WHERE id = ?').get(req.params.id);
    const ownerChanged = oldTask && String(oldTask.owner_id) !== String(b.owner_id);

    const updateJobId = b.job_id || null;
    const division = b.division || 'ops';
    const completedDate = b.status === 'complete' ? new Date().toISOString().split('T')[0] : null;
    db.prepare(`
      UPDATE tasks SET job_id=?, division=?, title=?, description=?, owner_id=?, due_date=?,
      status=?, priority=?, task_type=?, notes=?, completed_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(updateJobId, division, b.title, b.description || '', b.owner_id, b.due_date,
      b.status, b.priority, b.task_type || 'one_off', b.notes || '', completedDate, req.params.id);

    // Send email to new owner if reassigned (fire-and-forget)
    if (ownerChanged && b.owner_id) {
      try {
        const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(b.owner_id);
        const job = updateJobId ? db.prepare('SELECT job_number, client FROM jobs WHERE id = ?').get(updateJobId) : null;
        const jobLabel = job ? `${job.job_number} - ${job.client}` : 'General';
        const assignedByName = req.session.user ? req.session.user.full_name : '';
        const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const taskData = { id: req.params.id, title: b.title, description: b.description || '', due_date: b.due_date, priority: b.priority || 'medium', task_type: b.task_type || 'one_off' };
        sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
      } catch (emailErr) {
        console.error('[Tasks] Email send error on reassign:', emailErr.message);
      }
    }

    req.flash('success', 'Task updated.');
    res.redirect(b.return_to || '/tasks');
  } catch (err) {
    console.error('[Tasks] Update error:', err.message, err.stack);
    req.flash('error', 'Failed to update task: ' + err.message);
    res.redirect('/tasks/' + req.params.id + '/edit');
  }
});

// POST /:id/status — Quick inline status change
router.post('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const newStatus = req.body.status;
    const validStatuses = ['not_started', 'in_progress', 'blocked', 'complete'];
    if (!validStatuses.includes(newStatus)) {
      req.flash('error', 'Invalid status.');
      return res.redirect(req.headers.referer || '/tasks');
    }
    const today = new Date().toISOString().split('T')[0];
    const completedDate = newStatus === 'complete' ? today : null;
    db.prepare('UPDATE tasks SET status = ?, completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newStatus, completedDate, req.params.id);

    // Send status change email to task owner (fire-and-forget)
    try {
      const task = db.prepare('SELECT t.*, j.job_number, j.client FROM tasks t LEFT JOIN jobs j ON t.job_id = j.id WHERE t.id = ?').get(req.params.id);
      if (task && task.owner_id) {
        const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(task.owner_id);
        const changedByName = req.session.user ? req.session.user.full_name : '';
        const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        sendTaskStatusEmail(task, ownerUser, newStatus, changedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
      }
    } catch (emailErr) {
      console.error('[Tasks] Email send error on status change:', emailErr.message);
    }

    req.flash('success', 'Status updated.');
    res.redirect(req.headers.referer || '/tasks');
  } catch (err) {
    console.error('[Tasks] Status change error:', err.message, err.stack);
    req.flash('error', 'Failed to update status.');
    res.redirect(req.headers.referer || '/tasks');
  }
});

// POST /:id/complete — Quick complete
router.post('/:id/complete', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare("UPDATE tasks SET status = 'complete', completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(today, req.params.id);
  req.flash('success', 'Task completed.');
  res.redirect(req.headers.referer || '/tasks');
});

// POST /:id/delete — Delete task
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  req.flash('success', 'Task deleted.');
  res.redirect(req.body.return_to || '/tasks');
});

module.exports = router;
