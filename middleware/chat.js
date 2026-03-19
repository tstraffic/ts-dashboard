const { getDb } = require('../db/database');
const { getTotalUnreadCount } = require('../lib/chat');

/**
 * Middleware: check that the current user is a member of the thread (or is management).
 * Expects :threadId in route params.
 */
function requireThreadMember(req, res, next) {
  const db = getDb();
  const threadId = req.params.threadId;
  const userId = req.session.user.id;

  // Management can access all threads
  if (req.session.user.role === 'management') return next();

  const member = db.prepare(
    'SELECT id FROM chat_thread_members WHERE thread_id = ? AND user_id = ?'
  ).get(threadId, userId);

  if (!member) {
    if (req.path.includes('/api/')) {
      return res.status(403).json({ error: 'You are not a member of this thread.' });
    }
    req.flash('error', 'You do not have access to this thread.');
    return res.redirect('/chat');
  }
  next();
}

/**
 * Global middleware: attach unread chat count to res.locals for sidebar badge.
 */
function chatUnreadCountMiddleware(req, res, next) {
  if (req.session && req.session.user) {
    try {
      res.locals.unreadChatMessages = getTotalUnreadCount(req.session.user.id);
    } catch (e) {
      res.locals.unreadChatMessages = 0;
    }
  } else {
    res.locals.unreadChatMessages = 0;
  }
  next();
}

module.exports = { requireThreadMember, chatUnreadCountMiddleware };
