const { getDb } = require('../db/database');

/**
 * Ensure a chat thread exists for a given entity. Returns the thread ID.
 * Idempotent — safe to call multiple times for the same entity.
 */
function ensureThreadForEntity(entityType, entityId, title, createdByUserId) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM chat_threads WHERE related_entity_type = ? AND related_entity_id = ?'
  ).get(entityType, entityId);
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO chat_threads (thread_type, related_entity_id, related_entity_type, title, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(entityType, entityId, entityType, title, createdByUserId);

  return Number(result.lastInsertRowid);
}

/**
 * Add users to a thread. Uses INSERT OR IGNORE so duplicates are safe.
 * Optionally posts a system message for each new member added.
 */
function addMembersToThread(threadId, userIds, role = 'member', silent = false) {
  const db = getDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)
  `);
  const checkStmt = db.prepare(
    'SELECT id FROM chat_thread_members WHERE thread_id = ? AND user_id = ?'
  );

  const added = [];
  for (const userId of userIds) {
    if (!userId) continue;
    const existing = checkStmt.get(threadId, userId);
    if (!existing) {
      insertStmt.run(threadId, userId, role);
      added.push(userId);
    }
  }

  if (!silent && added.length > 0) {
    const userNames = db.prepare(
      `SELECT id, full_name FROM users WHERE id IN (${added.map(() => '?').join(',')})`
    ).all(...added);
    for (const u of userNames) {
      postSystemMessage(threadId, `${u.full_name} joined the thread`);
    }
  }

  return added;
}

/**
 * Post a system message (no sender) into a thread.
 */
function postSystemMessage(threadId, body) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, NULL, ?, 'system')
  `).run(threadId, body);

  // Update thread timestamp
  db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

  return Number(result.lastInsertRowid);
}

/**
 * Get the thread ID for a given entity, or null if none exists.
 */
function getThreadForEntity(entityType, entityId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT id FROM chat_threads WHERE related_entity_type = ? AND related_entity_id = ?'
  ).get(entityType, entityId);
  return row ? row.id : null;
}

/**
 * Get unread message count for a user across all their threads.
 */
function getTotalUnreadCount(userId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(unread), 0) as total FROM (
      SELECT COUNT(m.id) as unread
      FROM chat_thread_members ctm
      JOIN messages m ON m.thread_id = ctm.thread_id
        AND m.id > COALESCE(ctm.last_read_message_id, 0)
        AND m.deleted_at IS NULL
        AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)
      JOIN chat_threads ct ON ct.id = ctm.thread_id AND ct.status = 'active'
      WHERE ctm.user_id = ?
      GROUP BY ctm.thread_id
    )
  `).get(userId);
  return row ? row.total : 0;
}

module.exports = {
  ensureThreadForEntity,
  addMembersToThread,
  postSystemMessage,
  getThreadForEntity,
  getTotalUnreadCount
};
