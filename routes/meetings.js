// routes/meetings.js — Company Meetings: the weekly all-of-company minutes.
// Minutes are a list of discussion items, each optionally tagged to a
// department, each with optional to-dos. Department hubs render their tagged
// slice straight from these tables (routes/departments.js) — same rows, so a
// tick on a hub is a tick here. Mounted behind requirePermission('meetings')
// (admin/management); the hub slice is how everyone else consumes it.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');
const { DEPARTMENTS, DEPARTMENT_ORDER } = require('../lib/departments');

// ── Attachment uploads ───────────────────────────────────────────────────────
// Same conventions as booking documents: files live under data/uploads/
// (the only tree that survives a Railway deploy), stored as app-relative
// paths, served by the /data/uploads static mount.
const MEETING_UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'meetings');
const meetingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(MEETING_UPLOAD_DIR, 'meeting_' + req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).substring(7) + ext);
  },
});
const MEETING_FILE_TYPES = /\.(pdf|doc|docx|xls|xlsx|csv|txt|png|jpg|jpeg|gif|webp|heic)$/i;
const meetingUpload = multer({
  storage: meetingStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (MEETING_FILE_TYPES.test(file.originalname)) cb(null, true);
    else cb(new Error('File type not allowed. Accepted: images, PDF, Word, Excel, CSV, TXT.'), false);
  },
});
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|heic)$/i;

function relUploadPath(absPath) {
  // 'data/uploads/meetings/meeting_7/x.jpg' — app-relative, no leading slash.
  return path.relative(path.join(__dirname, '..'), absPath).split(path.sep).join('/');
}
function unlinkQuiet(rel) {
  try { fs.unlinkSync(path.join(__dirname, '..', rel)); } catch (e) { /* already gone */ }
}

// Friendly day header — same rendering as the dept hubs, anchored to the
// Sydney calendar day (routes/departments.js dayLabel; notes' UTC version is
// the wrong one to copy).
function dayLabel(iso, today) {
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function isAdmin(user) {
  const r = String((user && user.role) || '').toLowerCase();
  return r === 'admin' || r === 'management';
}

// Dept tag vocabulary = the live department registry, so a new department is
// taggable the moment it exists. '' / unknown => NULL (a general item).
function deptOptions() {
  return DEPARTMENT_ORDER.map((k) => ({ key: k, label: DEPARTMENTS[k].label }));
}
function normaliseDeptKey(raw) {
  const key = String(raw || '').trim();
  return DEPARTMENT_ORDER.includes(key) ? key : null;
}

// Loads a meeting and 404s when missing — every subroute goes through this.
function loadMeeting(req, res) {
  const m = getDb().prepare('SELECT * FROM company_meetings WHERE id = ?').get(req.params.id);
  if (!m) {
    res.status(404).render('error', { title: 'Not Found', message: 'Meeting not found.', user: req.session.user });
    return null;
  }
  return m;
}

function meetingUrl(id) {
  return '/meetings/' + id;
}

// Same 3-CASE toggle as the dept notebook's — duplicated per house style
// rather than parameterising the table name.
function toggleTodo(db, todoId, userId) {
  db.prepare(`
    UPDATE company_meeting_todos SET
      done = CASE done WHEN 1 THEN 0 ELSE 1 END,
      done_at = CASE done WHEN 1 THEN NULL ELSE CURRENT_TIMESTAMP END,
      done_by_id = CASE done WHEN 1 THEN NULL ELSE ? END
    WHERE id = ?
  `).run(userId, todoId);
}

// ── Register ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const today = sydneyToday();

  let upcoming = [], past = [];
  try {
    const withTodos = `
      SELECT m.*, c.company_name AS client_name,
             (SELECT COUNT(*) FROM company_meeting_todos t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todos
      FROM company_meetings m
      LEFT JOIN clients c ON c.id = m.client_id`;
    upcoming = db.prepare(`${withTodos} WHERE m.meeting_date >= ? ORDER BY m.meeting_date ASC, m.meeting_time ASC, m.id ASC`).all(today);
    const pastLimit = req.query.past === 'all' ? 1000 : 15;
    past = db.prepare(`${withTodos} WHERE m.meeting_date < ? ORDER BY m.meeting_date DESC, m.meeting_time DESC, m.id DESC LIMIT ?`).all(today, pastLimit);
  } catch (e) { console.error('[meetings] register query failed:', e.message); }

  // Client list for the "meeting with a client" picker on the create form.
  let clients = [];
  try { clients = db.prepare('SELECT id, company_name FROM clients ORDER BY company_name').all(); } catch (e) {}

  let openTodos = [];
  try {
    openTodos = db.prepare(`
      SELECT t.*, m.title AS meeting_title, m.meeting_date
      FROM company_meeting_todos t JOIN company_meetings m ON m.id = t.meeting_id
      WHERE t.done = 0
      ORDER BY CASE t.priority WHEN 'high' THEN 0 ELSE 1 END, t.created_at ASC
    `).all();
  } catch (e) { console.error('[meetings] todos query failed:', e.message); }

  res.render('meetings/index', {
    title: 'Meetings',
    user: req.session.user,
    upcoming, past, openTodos, today, clients,
    depts: deptOptions(),
    pastExpanded: req.query.past === 'all',
    dayLabel: (iso) => dayLabel(iso, today),
    currentPage: 'meetings',
  });
});

// ── Create meeting ──────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();
  const attendees = String(req.body.attendees || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect('/meetings#add-meeting'));
  }

  // Client meeting: type flips to 'client' and the client link is validated.
  // A client pick with no explicit type still counts as a client meeting.
  let clientId = req.body.client_id ? parseInt(req.body.client_id, 10) : null;
  if (clientId) {
    const c = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!c) clientId = null;
  }
  const meetingType = (req.body.meeting_type === 'client' || clientId) ? 'client' : 'company';

  const result = db.prepare(`
    INSERT INTO company_meetings (title, meeting_date, meeting_time, attendees, meeting_type, client_id, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(title, date, time, attendees, meetingType, clientId, req.session.user.id);

  try {
    logActivity({ user: req.session.user, action: 'create', entityType: 'company_meeting', entityId: result.lastInsertRowid, entityLabel: title, ip: req.ip });
  } catch (e) { /* never block the write */ }
  req.flash('success', 'Meeting created.');
  req.session.save(() => res.redirect(meetingUrl(result.lastInsertRowid)));
});

// ── Meeting page ────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();

  const items = db.prepare('SELECT * FROM company_meeting_items WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const todos = db.prepare('SELECT * FROM company_meeting_todos WHERE meeting_id = ? ORDER BY done ASC, position ASC, id ASC').all(meeting.id);

  // Structured minutes: headings → dot points, with captioned attachments
  // hanging off either level. Legacy DBs (pre-347) just get empty lists.
  let sections = [], pointsBySection = new Map(), attachments = [];
  try {
    sections = db.prepare('SELECT * FROM company_meeting_sections WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
    const points = db.prepare('SELECT * FROM company_meeting_points WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
    for (const p of points) {
      if (!pointsBySection.has(p.section_id)) pointsBySection.set(p.section_id, []);
      pointsBySection.get(p.section_id).push(p);
    }
    attachments = db.prepare('SELECT * FROM company_meeting_attachments WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  } catch (e) { /* pre-347 schema */ }
  const attachmentsBySection = new Map();
  const attachmentsByPoint = new Map();
  for (const a of attachments) {
    if (a.point_id != null) {
      if (!attachmentsByPoint.has(a.point_id)) attachmentsByPoint.set(a.point_id, []);
      attachmentsByPoint.get(a.point_id).push(a);
    } else if (a.section_id != null) {
      if (!attachmentsBySection.has(a.section_id)) attachmentsBySection.set(a.section_id, []);
      attachmentsBySection.get(a.section_id).push(a);
    }
  }

  let clientName = '';
  if (meeting.client_id) {
    try { const c = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(meeting.client_id); if (c) clientName = c.company_name; } catch (e) {}
  }
  let clients = [];
  try { clients = db.prepare('SELECT id, company_name FROM clients ORDER BY company_name').all(); } catch (e) {}

  // Group todos under their item; item_id NULL (meeting-level adds, or
  // orphans left behind by an item delete) go to the General bucket.
  const todosByItem = new Map();
  const generalTodos = [];
  for (const t of todos) {
    if (t.item_id != null && items.some((i) => i.id === t.item_id)) {
      if (!todosByItem.has(t.item_id)) todosByItem.set(t.item_id, []);
      todosByItem.get(t.item_id).push(t);
    } else {
      generalTodos.push(t);
    }
  }

  res.render('meetings/show', {
    title: meeting.title,
    user: req.session.user,
    meeting, items, todosByItem, generalTodos,
    sections, pointsBySection, attachmentsBySection, attachmentsByPoint,
    clientName, clients,
    depts: deptOptions(),
    canDelete: meeting.created_by_id === req.session.user.id || isAdmin(req.session.user),
    currentPage: 'meetings',
  });
});

// ── Edit meeting details ────────────────────────────────────────────────────
router.post('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#edit'));
  }

  const db = getDb();
  let clientId = req.body.client_id ? parseInt(req.body.client_id, 10) : null;
  if (clientId) {
    const c = db.prepare('SELECT id FROM clients WHERE id = ?').get(clientId);
    if (!c) clientId = null;
  }
  const meetingType = (req.body.meeting_type === 'client' || clientId) ? 'client' : 'company';
  db.prepare(`
    UPDATE company_meetings SET title = ?, meeting_date = ?, meeting_time = ?, attendees = ?, meeting_type = ?, client_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(title, date, time, String(req.body.attendees || '').trim(), meetingType, clientId, meeting.id);

  req.flash('success', 'Meeting details updated.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// ── Discussion items ────────────────────────────────────────────────────────
router.post('/:id/items', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const body = String(req.body.body || '').trim();
  const deptKey = normaliseDeptKey(req.body.dept_key);
  if (!body) {
    req.flash('error', 'A discussion item needs some text.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#add-item'));
  }
  const db = getDb();
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_items WHERE meeting_id = ?').get(meeting.id).p;
    db.prepare(`
      INSERT INTO company_meeting_items (meeting_id, dept_key, body, position, created_by_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(meeting.id, deptKey, body, pos, req.session.user.id);
  })();
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#add-item'));
});

// Item must belong to the meeting in the URL before any mutation.
function loadItem(req, meetingId) {
  return getDb().prepare('SELECT * FROM company_meeting_items WHERE id = ? AND meeting_id = ?').get(req.params.itemId, meetingId);
}

router.post('/:id/items/:itemId', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const item = loadItem(req, meeting.id);
  if (!item) {
    req.flash('error', 'Item not found.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  const body = String(req.body.body || '').trim();
  const deptKey = normaliseDeptKey(req.body.dept_key);
  if (!body) {
    req.flash('error', 'A discussion item needs some text.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#item-' + item.id));
  }
  const db = getDb();
  // Re-tagging an item drags along only the to-dos that were FOLLOWING it
  // (dept matches the item's old tag). To-dos an operator deliberately tagged
  // to another department keep their tag — `IS ?` so NULL-tagged (General)
  // followers under a General item move too.
  db.transaction(() => {
    db.prepare('UPDATE company_meeting_todos SET dept_key = ? WHERE item_id = ? AND dept_key IS ?').run(deptKey, item.id, item.dept_key);
    db.prepare('UPDATE company_meeting_items SET body = ?, dept_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body, deptKey, item.id);
  })();
  req.flash('success', 'Saved.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#item-' + item.id));
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const item = loadItem(req, meeting.id);
  if (item) {
    // Todos survive via ON DELETE SET NULL, keeping their dept tag — an open
    // action item is never destroyed by tidying the minutes.
    getDb().prepare('DELETE FROM company_meeting_items WHERE id = ?').run(item.id);
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// ── To-dos ──────────────────────────────────────────────────────────────────
router.post('/:id/todos', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const text = String(req.body.text || '').trim();
  const priority = req.body.priority === 'high' ? 'high' : 'low';
  if (!text) {
    req.flash('error', 'To-do text is required.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  const db = getDb();
  // Optional item link — must belong to this meeting.
  let item = null;
  if (req.body.item_id) {
    item = db.prepare('SELECT * FROM company_meeting_items WHERE id = ? AND meeting_id = ?').get(req.body.item_id, meeting.id);
  }
  // To-dos carry their own department tag (that tag is what routes them to a
  // hub). The form pre-selects the item's dept, so an explicit dept_key wins;
  // a POST without one (older client) falls back to inheriting from the item.
  const deptKey = ('dept_key' in req.body)
    ? normaliseDeptKey(req.body.dept_key)
    : (item ? item.dept_key : null);
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_todos WHERE meeting_id = ? AND priority = ?').get(meeting.id, priority).p;
    db.prepare(`
      INSERT INTO company_meeting_todos (meeting_id, item_id, dept_key, text, priority, position, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(meeting.id, item ? item.id : null, deptKey, text, priority, pos, req.session.user.id);
  })();
  const anchor = item ? '#item-' + item.id : '#general-todos';
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + anchor));
});

// Re-tag a single to-do — the per-row dept select on the meeting page.
router.post('/:id/todos/:todoId/dept', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const todo = db.prepare('SELECT id, item_id FROM company_meeting_todos WHERE id = ? AND meeting_id = ?').get(req.params.todoId, meeting.id);
  if (todo) {
    db.prepare('UPDATE company_meeting_todos SET dept_key = ? WHERE id = ?').run(normaliseDeptKey(req.body.dept_key), todo.id);
  }
  const anchor = todo && todo.item_id ? '#item-' + todo.item_id : '#general-todos';
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + anchor));
});

router.post('/:id/todos/:todoId/toggle', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const todo = db.prepare('SELECT id, item_id FROM company_meeting_todos WHERE id = ? AND meeting_id = ?').get(req.params.todoId, meeting.id);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  const anchor = todo && todo.item_id ? '#item-' + todo.item_id : '#general-todos';
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + anchor));
});

router.post('/:id/todos/:todoId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  getDb().prepare('DELETE FROM company_meeting_todos WHERE id = ? AND meeting_id = ?').run(req.params.todoId, meeting.id);
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// Register-side tick — close a to-do from the /meetings list page.
router.post('/todos/:todoId/toggle', (req, res) => {
  const db = getDb();
  const todo = db.prepare('SELECT id FROM company_meeting_todos WHERE id = ?').get(req.params.todoId);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  req.session.save(() => res.redirect('/meetings'));
});

// ── Cancel / restore + delete ───────────────────────────────────────────────
router.post('/:id/cancel', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const next = meeting.status === 'cancelled' ? 'scheduled' : 'cancelled';
  getDb().prepare('UPDATE company_meetings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, meeting.id);
  try {
    logActivity({ user: req.session.user, action: 'update', entityType: 'company_meeting', entityId: meeting.id, entityLabel: meeting.title, details: next === 'cancelled' ? 'Meeting cancelled' : 'Meeting restored', ip: req.ip });
  } catch (e) { /* ignore */ }
  req.flash('success', next === 'cancelled' ? 'Meeting cancelled.' : 'Meeting restored.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

router.post('/:id/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  if (meeting.created_by_id !== req.session.user.id && !isAdmin(req.session.user)) {
    req.flash('error', 'Only the meeting creator or an admin can delete a meeting.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  getDb().prepare('DELETE FROM company_meetings WHERE id = ?').run(meeting.id); // items + todos cascade
  try {
    logActivity({ user: req.session.user, action: 'delete', entityType: 'company_meeting', entityId: meeting.id, entityLabel: meeting.title, ip: req.ip });
  } catch (e) { /* ignore */ }
  req.flash('success', 'Meeting deleted.');
  req.session.save(() => res.redirect('/meetings'));
});

// ── Structured minutes: headings ─────────────────────────────────────────────
function loadSection(req, meetingId) {
  return getDb().prepare('SELECT * FROM company_meeting_sections WHERE id = ? AND meeting_id = ?').get(req.params.sectionId, meetingId);
}

router.post('/:id/sections', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const title = String(req.body.title || '').trim();
  if (!title) {
    req.flash('error', 'A heading needs a title.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#add-section'));
  }
  const db = getDb();
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_sections WHERE meeting_id = ?').get(meeting.id).p;
  const r = db.prepare('INSERT INTO company_meeting_sections (meeting_id, title, position, created_by_id) VALUES (?, ?, ?, ?)')
    .run(meeting.id, title, pos, req.session.user.id);
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#section-' + r.lastInsertRowid));
});

router.post('/:id/sections/:sectionId', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const section = loadSection(req, meeting.id);
  const title = String(req.body.title || '').trim();
  if (section && title) {
    getDb().prepare('UPDATE company_meeting_sections SET title = ? WHERE id = ?').run(title, section.id);
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + (section ? '#section-' + section.id : '')));
});

router.post('/:id/sections/:sectionId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const section = loadSection(req, meeting.id);
  if (section) {
    const db = getDb();
    // Cascade removes points + attachment rows; unlink the files first so
    // deletes don't strand orphans on the volume.
    const files = db.prepare('SELECT file_path FROM company_meeting_attachments WHERE section_id = ? OR point_id IN (SELECT id FROM company_meeting_points WHERE section_id = ?)').all(section.id, section.id);
    db.prepare('DELETE FROM company_meeting_sections WHERE id = ?').run(section.id);
    files.forEach((f) => unlinkQuiet(f.file_path));
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// ── Structured minutes: dot points ──────────────────────────────────────────
function loadPoint(req, meetingId) {
  return getDb().prepare('SELECT * FROM company_meeting_points WHERE id = ? AND meeting_id = ?').get(req.params.pointId, meetingId);
}

router.post('/:id/sections/:sectionId/points', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const section = loadSection(req, meeting.id);
  const text = String(req.body.text || '').trim();
  if (!section || !text) {
    req.flash('error', 'A dot point needs some text.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  const db = getDb();
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_points WHERE section_id = ?').get(section.id).p;
  db.prepare('INSERT INTO company_meeting_points (section_id, meeting_id, text, position) VALUES (?, ?, ?, ?)')
    .run(section.id, meeting.id, text, pos);
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#section-' + section.id));
});

router.post('/:id/points/:pointId', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const point = loadPoint(req, meeting.id);
  const text = String(req.body.text || '').trim();
  if (point && text) {
    getDb().prepare('UPDATE company_meeting_points SET text = ? WHERE id = ?').run(text, point.id);
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + (point ? '#section-' + point.section_id : '')));
});

router.post('/:id/points/:pointId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const point = loadPoint(req, meeting.id);
  if (point) {
    const db = getDb();
    const files = db.prepare('SELECT file_path FROM company_meeting_attachments WHERE point_id = ?').all(point.id);
    db.prepare('DELETE FROM company_meeting_points WHERE id = ?').run(point.id);
    files.forEach((f) => unlinkQuiet(f.file_path));
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + (point ? '#section-' + point.section_id : '')));
});

// ── Structured minutes: photos & files (with captions) ──────────────────────
// One endpoint for both levels: section_id required, point_id optional (must
// belong to that section). The caption applies to every file in the batch —
// in practice photos are added one at a time with their caption.
router.post('/:id/attachments', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  meetingUpload.array('files', 10)(req, res, (err) => {
    if (err) {
      req.flash('error', err.message || 'Upload failed.');
      return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
    }
    const db = getDb();
    const section = db.prepare('SELECT * FROM company_meeting_sections WHERE id = ? AND meeting_id = ?').get(req.body.section_id, meeting.id);
    if (!section) {
      (req.files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch (e) {} });
      req.flash('error', 'Pick a heading to attach under.');
      return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
    }
    let point = null;
    if (req.body.point_id) {
      point = db.prepare('SELECT * FROM company_meeting_points WHERE id = ? AND section_id = ?').get(req.body.point_id, section.id);
    }
    const caption = String(req.body.caption || '').trim();
    const files = req.files || [];
    if (!files.length) {
      req.flash('error', 'Pick at least one photo or file.');
      return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#section-' + section.id));
    }
    const ins = db.prepare(`
      INSERT INTO company_meeting_attachments
        (meeting_id, section_id, point_id, file_path, original_name, mime_type, size_bytes, is_image, caption, position, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const basePos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM company_meeting_attachments WHERE meeting_id = ?').get(meeting.id).p;
    files.forEach((f, i) => {
      ins.run(meeting.id, section.id, point ? point.id : null, relUploadPath(f.path),
        f.originalname, f.mimetype || '', f.size || 0,
        IMAGE_EXT.test(f.originalname) ? 1 : 0, caption, basePos + i + 1, req.session.user.id);
    });
    req.flash('success', files.length === 1 ? 'Attached.' : files.length + ' files attached.');
    req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#section-' + section.id));
  });
});

router.post('/:id/attachments/:attId/caption', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const att = db.prepare('SELECT * FROM company_meeting_attachments WHERE id = ? AND meeting_id = ?').get(req.params.attId, meeting.id);
  if (att) db.prepare('UPDATE company_meeting_attachments SET caption = ? WHERE id = ?').run(String(req.body.caption || '').trim(), att.id);
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + (att && att.section_id ? '#section-' + att.section_id : '')));
});

router.post('/:id/attachments/:attId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const att = db.prepare('SELECT * FROM company_meeting_attachments WHERE id = ? AND meeting_id = ?').get(req.params.attId, meeting.id);
  if (att) {
    db.prepare('DELETE FROM company_meeting_attachments WHERE id = ?').run(att.id);
    unlinkQuiet(att.file_path);
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + (att && att.section_id ? '#section-' + att.section_id : '')));
});

// ── PDF export ───────────────────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  try {
    const { renderMeetingPdf } = require('../services/meetingPdf');
    const buf = await renderMeetingPdf(db, meeting);
    const dateBit = String(meeting.meeting_date || '').replace(/[^\d-]/g, '');
    const nameBit = String(meeting.title || 'meeting').replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'meeting';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Meeting-minutes-${dateBit}-${nameBit}.pdf"`);
    res.send(buf);
    try { logActivity({ user: req.session.user, action: 'export', entityType: 'company_meeting', entityId: meeting.id, entityLabel: meeting.title, details: 'Minutes exported as PDF', ip: req.ip }); } catch (e) {}
  } catch (e) {
    console.error('[meetings] PDF export failed:', e.message);
    req.flash('error', 'Could not generate the PDF: ' + e.message);
    req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
});

module.exports = router;
