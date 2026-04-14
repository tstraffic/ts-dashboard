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

/**
 * Find or create a DM thread between two users. Returns thread ID.
 */
function findOrCreateDM(user1Id, user2Id) {
  const db = getDb();
  // Find existing DM between these two users (both must be members, thread_type = 'dm')
  const existing = db.prepare(`
    SELECT ct.id FROM chat_threads ct
    JOIN chat_thread_members m1 ON m1.thread_id = ct.id AND m1.user_id = ?
    JOIN chat_thread_members m2 ON m2.thread_id = ct.id AND m2.user_id = ?
    WHERE ct.thread_type = 'dm' AND ct.status = 'active'
    LIMIT 1
  `).get(user1Id, user2Id);
  if (existing) return existing.id;

  // Create new DM
  const user2 = db.prepare('SELECT full_name FROM users WHERE id = ?').get(user2Id);
  const user1 = db.prepare('SELECT full_name FROM users WHERE id = ?').get(user1Id);
  const title = `${user1 ? user1.full_name : 'User'} & ${user2 ? user2.full_name : 'User'}`;

  const result = db.prepare(`
    INSERT INTO chat_threads (thread_type, title, created_by) VALUES ('dm', ?, ?)
  `).run(title, user1Id);
  const threadId = Number(result.lastInsertRowid);

  db.prepare('INSERT INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(threadId, user1Id, 'member');
  db.prepare('INSERT INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(threadId, user2Id, 'member');

  return threadId;
}

/**
 * Ensure default channels exist and all active users are in All Team. Called on server startup.
 */
function ensureDefaultChannels() {
  const db = getDb();
  // Check if chat_threads table exists (may not on first boot before migration 54)
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_threads'").get();
  if (!tableExists) return;

  const channels = [
    { slug: 'all-team', title: 'All Team', type: 'announcement' },
    { slug: 'office-team', title: 'Office Team', type: 'channel' },
    { slug: 'operations', title: 'Operations', type: 'channel' },
    { slug: 'field-workers', title: 'Field Workers', type: 'channel' },
    { slug: 'supervisors', title: 'Supervisors', type: 'channel' },
    { slug: 'planning', title: 'Planning', type: 'channel' },
  ];
  for (const ch of channels) {
    const exists = db.prepare('SELECT id FROM chat_threads WHERE channel_slug = ?').get(ch.slug);
    if (!exists) {
      db.prepare("INSERT INTO chat_threads (thread_type, title, status, is_default, channel_slug) VALUES (?, ?, 'active', 1, ?)").run(ch.type, ch.title, ch.slug);
    }
  }

  // Remove default admin account from all channels (username = 'admin')
  try {
    const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
    if (adminUser) {
      db.prepare('DELETE FROM chat_thread_members WHERE user_id = ?').run(adminUser.id);
    }
  } catch(e) {}

  // Ensure all active non-admin users are in All Team
  const allTeam = db.prepare("SELECT id FROM chat_threads WHERE channel_slug = 'all-team'").get();
  if (allTeam) {
    const users = db.prepare("SELECT id, role FROM users WHERE active = 1 AND username != 'admin'").all();
    const addMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
    for (const u of users) {
      addMember.run(allTeam.id, u.id, 'member');
    }
    // Also add users to role-based channels
    for (const u of users) {
      autoAddUserToChannels(u.id, u.role);
    }
  }

  // Ensure Office Team has the right members: Saadat, Taj, Suhail, Rumman, Savanah
  const officeTeam = db.prepare("SELECT id FROM chat_threads WHERE channel_slug = 'office-team'").get();
  if (officeTeam) {
    const officeUsers = db.prepare("SELECT id FROM users WHERE username IN ('saadat', 'taj', 'suhail.a', 'savanah') AND active = 1").all();
    // Also find Rumman by name if username doesn't match
    const rumman = db.prepare("SELECT id FROM users WHERE full_name LIKE '%Rumman%' AND active = 1").get();
    const addMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
    for (const u of officeUsers) {
      addMember.run(officeTeam.id, u.id, 'member');
    }
    if (rumman) addMember.run(officeTeam.id, rumman.id, 'member');
  }
}

/**
 * Auto-add a user to default channels based on their role.
 */
function autoAddUserToChannels(userId, role) {
  const db = getDb();
  // Skip the default admin account
  const isAdmin = db.prepare("SELECT 1 FROM users WHERE id = ? AND username = 'admin'").get(userId);
  if (isAdmin) return;

  // Always add to All Team
  const allTeam = db.prepare("SELECT id FROM chat_threads WHERE channel_slug = 'all-team'").get();
  if (allTeam) {
    db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(allTeam.id, userId, 'member');
  }

  // Role-based channel mapping
  const roleChannels = {
    admin: ['operations', 'supervisors', 'planning', 'field-workers'],
    operations: ['operations', 'supervisors', 'field-workers'],
    planning: ['planning', 'field-workers'],
    finance: [],
    hr: [],
    sales: [],
    management: ['operations', 'supervisors', 'planning'],
    marketing: [],
    accounts: [],
  };

  const slugs = roleChannels[role] || [];
  for (const slug of slugs) {
    const ch = db.prepare('SELECT id FROM chat_threads WHERE channel_slug = ?').get(slug);
    if (ch) {
      db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(ch.id, userId, 'member');
    }
  }
}

module.exports = {
  ensureThreadForEntity,
  addMembersToThread,
  postSystemMessage,
  getThreadForEntity,
  getTotalUnreadCount,
  findOrCreateDM,
  ensureDefaultChannels,
  autoAddUserToChannels
};
