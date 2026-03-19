const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requireThreadMember } = require('../middleware/chat');
const { logActivity } = require('../middleware/audit');

// ============================================
// Multer config for chat image uploads
// ============================================
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const threadId = req.body.thread_id || 'general';
    const dir = path.join(__dirname, '..', 'public', 'uploads', 'chat', `thread_${threadId}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ============================================
// HTML: Messages Inbox Page
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const isManagement = req.session.user.role === 'management';

  let threads;
  if (isManagement) {
    threads = db.prepare(`
      SELECT ct.*,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL) as message_count,
        (SELECT m.body FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at,
        (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_sender,
        (SELECT COUNT(m.id) FROM chat_thread_members ctm2 JOIN messages m ON m.thread_id = ctm2.thread_id AND m.id > COALESCE(ctm2.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm2.user_id OR m.sender_id IS NULL) WHERE ctm2.thread_id = ct.id AND ctm2.user_id = ?) as unread_count
      FROM chat_threads ct
      WHERE ct.status = 'active'
      ORDER BY last_message_at DESC NULLS LAST, ct.created_at DESC
    `).all(userId);
  } else {
    threads = db.prepare(`
      SELECT ct.*,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL) as message_count,
        (SELECT m.body FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at,
        (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_sender,
        (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count
      FROM chat_thread_members ctm
      JOIN chat_threads ct ON ct.id = ctm.thread_id
      WHERE ctm.user_id = ? AND ct.status = 'active'
      ORDER BY last_message_at DESC NULLS LAST, ct.created_at DESC
    `).all(userId);
  }

  res.render('chat/inbox', {
    title: 'Messages',
    currentPage: 'chat',
    threads,
    user: req.session.user
  });
});

// ============================================
// API: Get threads for current user (JSON)
// ============================================
router.get('/api/threads', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const isManagement = req.session.user.role === 'management';

  let threads;
  if (isManagement) {
    threads = db.prepare(`
      SELECT ct.id, ct.thread_type, ct.title, ct.status,
        (SELECT COUNT(m.id) FROM chat_thread_members ctm2 JOIN messages m ON m.thread_id = ctm2.thread_id AND m.id > COALESCE(ctm2.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm2.user_id OR m.sender_id IS NULL) WHERE ctm2.thread_id = ct.id AND ctm2.user_id = ?) as unread_count
      FROM chat_threads ct WHERE ct.status = 'active'
    `).all(userId);
  } else {
    threads = db.prepare(`
      SELECT ct.id, ct.thread_type, ct.title, ct.status,
        (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count
      FROM chat_thread_members ctm
      JOIN chat_threads ct ON ct.id = ctm.thread_id
      WHERE ctm.user_id = ? AND ct.status = 'active'
    `).all(userId);
  }

  const totalUnread = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);
  res.json({ threads, totalUnread });
});

// ============================================
// API: Get messages for a thread (JSON, polling)
// ============================================
router.get('/api/threads/:threadId/messages', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const after = parseInt(req.query.after) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  const messages = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.message_type,
      m.reply_to_message_id, m.created_at, m.edited_at, m.deleted_at,
      u.full_name as sender_name, u.role as sender_role,
      rm.body as reply_to_body, ru.full_name as reply_to_sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.thread_id = ? AND m.id > ? AND m.deleted_at IS NULL
    ORDER BY m.id ASC
    LIMIT ?
  `).all(threadId, after, limit);

  // Load attachments for image/file messages
  const msgIds = messages.filter(m => m.message_type === 'image' || m.message_type === 'file').map(m => m.id);
  let attachments = {};
  if (msgIds.length > 0) {
    const rows = db.prepare(`
      SELECT * FROM message_attachments WHERE message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds);
    for (const a of rows) {
      if (!attachments[a.message_id]) attachments[a.message_id] = [];
      attachments[a.message_id].push(a);
    }
  }

  // Attach attachments to messages
  for (const msg of messages) {
    msg.attachments = attachments[msg.id] || [];
  }

  res.json({ messages });
});

// ============================================
// API: Send a message (JSON)
// ============================================
router.post('/api/threads/:threadId/messages', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const userId = req.session.user.id;
  const { body, message_type, reply_to_message_id, mentioned_user_ids, attachment } = req.body;

  if (!body && message_type !== 'image') {
    return res.status(400).json({ error: 'Message body is required.' });
  }

  const type = message_type || 'text';

  const result = db.prepare(`
    INSERT INTO messages (thread_id, sender_id, body, message_type, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, userId, body || '', type, reply_to_message_id || null);

  const messageId = Number(result.lastInsertRowid);

  // Handle attachment if provided (for image messages)
  if (attachment && attachment.file_url) {
    db.prepare(`
      INSERT INTO message_attachments (message_id, file_url, thumbnail_url, mime_type, file_size, original_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(messageId, attachment.file_url, attachment.thumbnail_url || '', attachment.mime_type || 'image/jpeg', attachment.file_size || 0, attachment.original_name || 'image');
  }

  // Handle mentions
  if (mentioned_user_ids && Array.isArray(mentioned_user_ids) && mentioned_user_ids.length > 0) {
    const mentionStmt = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) VALUES (?, ?)');
    const thread = db.prepare('SELECT title, related_entity_type, related_entity_id FROM chat_threads WHERE id = ?').get(threadId);
    const sender = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);

    for (const mentionedId of mentioned_user_ids) {
      mentionStmt.run(messageId, mentionedId);
      // Create notification for mentioned user
      if (mentionedId !== userId) {
        const entityLink = thread.related_entity_type === 'job'
          ? `/jobs/${thread.related_entity_id}#chat`
          : thread.related_entity_type === 'incident'
            ? `/incidents/${thread.related_entity_id}#chat`
            : `/compliance/${thread.related_entity_id}`;

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, link, job_id)
          VALUES (?, 'general', ?, ?, ?, NULL)
        `).run(
          mentionedId,
          `Mentioned by ${sender.full_name}`,
          `${sender.full_name} mentioned you in ${thread.title}`,
          entityLink
        );
      }
    }
  }

  // Update thread timestamp
  db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

  // Audit log
  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'message',
    entityId: messageId,
    entityLabel: body ? body.substring(0, 80) : '[image]',
    details: `Thread: ${threadId}, Type: ${type}`,
    ip: req.ip
  });

  // Return the created message with sender info
  const message = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.message_type,
      m.reply_to_message_id, m.created_at, m.edited_at,
      u.full_name as sender_name, u.role as sender_role
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.id = ?
  `).get(messageId);

  message.attachments = [];
  if (attachment && attachment.file_url) {
    message.attachments = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').all(messageId);
  }

  res.json({ message });
});

// ============================================
// API: Soft-delete own message (JSON)
// ============================================
router.post('/api/threads/:threadId/messages/:msgId/delete', requireThreadMember, (req, res) => {
  const db = getDb();
  const msgId = req.params.msgId;
  const userId = req.session.user.id;

  const msg = db.prepare('SELECT sender_id FROM messages WHERE id = ? AND thread_id = ?').get(msgId, req.params.threadId);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_id !== userId && req.session.user.role !== 'management') {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }

  db.prepare('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(msgId);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'message',
    entityId: parseInt(msgId),
    entityLabel: 'Soft-deleted message',
    details: `Thread: ${req.params.threadId}`,
    ip: req.ip
  });

  res.json({ success: true });
});

// ============================================
// API: Mark thread as read (JSON)
// ============================================
router.post('/api/threads/:threadId/read', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const userId = req.session.user.id;

  // Get the latest message ID in the thread
  const latest = db.prepare(
    'SELECT MAX(id) as max_id FROM messages WHERE thread_id = ? AND deleted_at IS NULL'
  ).get(threadId);

  if (latest && latest.max_id) {
    // Ensure membership row exists for management users
    const member = db.prepare('SELECT id FROM chat_thread_members WHERE thread_id = ? AND user_id = ?').get(threadId, userId);
    if (!member) {
      db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(threadId, userId, 'member');
    }
    db.prepare(
      'UPDATE chat_thread_members SET last_read_message_id = ? WHERE thread_id = ? AND user_id = ?'
    ).run(latest.max_id, threadId, userId);
  }

  res.json({ success: true });
});

// ============================================
// API: Get thread members (for @mention autocomplete)
// ============================================
router.get('/api/threads/:threadId/members', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;

  const members = db.prepare(`
    SELECT u.id, u.full_name, u.role, ctm.role_in_thread
    FROM chat_thread_members ctm
    JOIN users u ON ctm.user_id = u.id
    WHERE ctm.thread_id = ? AND u.active = 1
    ORDER BY u.full_name
  `).all(threadId);

  res.json({ members });
});

// ============================================
// API: Upload image (JSON)
// ============================================
router.post('/api/upload', chatUpload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded or invalid file type.' });
  }

  try {
    const sharp = require('sharp');
    const thumbFilename = 'thumb_' + req.file.filename;
    const thumbPath = path.join(req.file.destination, thumbFilename);

    await sharp(req.file.path)
      .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);

    const threadDir = path.basename(req.file.destination);
    const fileUrl = `/uploads/chat/${threadDir}/${req.file.filename}`;
    const thumbnailUrl = `/uploads/chat/${threadDir}/${thumbFilename}`;

    res.json({
      file_url: fileUrl,
      thumbnail_url: thumbnailUrl,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      original_name: req.file.originalname
    });
  } catch (err) {
    console.error('Image processing error:', err);
    // Fall back to serving the original without thumbnail
    const threadDir = path.basename(req.file.destination);
    const fileUrl = `/uploads/chat/${threadDir}/${req.file.filename}`;
    res.json({
      file_url: fileUrl,
      thumbnail_url: fileUrl,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      original_name: req.file.originalname
    });
  }
});

// ============================================
// API: Get unread count (lightweight, for badge polling)
// ============================================
router.get('/api/unread-count', (req, res) => {
  const { getTotalUnreadCount } = require('../lib/chat');
  const count = getTotalUnreadCount(req.session.user.id);
  res.json({ count });
});

module.exports = router;
