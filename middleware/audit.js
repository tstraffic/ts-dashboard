// Audit trail middleware - logs all create/update/delete actions
const { getDb } = require('../db/database');

/**
 * Log an activity to the audit trail
 * @param {Object} options
 * @param {Object} options.user - Session user object { id, full_name }
 * @param {string} options.action - create|update|delete|login|logout|upload|download|complete|approve|reject
 * @param {string} options.entityType - e.g. 'job', 'task', 'incident', 'compliance'
 * @param {number} [options.entityId] - ID of the affected record
 * @param {string} [options.entityLabel] - Human-readable label (e.g. job number, task title)
 * @param {number} [options.jobId] - Related job ID (for filtering by job)
 * @param {string} [options.jobNumber] - Related job number
 * @param {string} [options.details] - Extra details about the action
 * @param {string} [options.ip] - IP address
 */
function logActivity({ user, action, entityType, entityId, entityLabel, jobId, jobNumber, details, ip }) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, entity_label, job_id, job_number, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user ? user.id : null,
      user ? user.full_name : 'System',
      action,
      entityType,
      entityId || null,
      entityLabel || '',
      jobId || null,
      jobNumber || '',
      details || '',
      ip || ''
    );
  } catch (err) {
    // Never let audit logging break the main request
    console.error('Audit log error:', err.message);
  }
}

/**
 * Express middleware that attaches logActivity to req for easy use in routes
 */
function auditMiddleware(req, res, next) {
  req.logActivity = (opts) => {
    logActivity({
      ...opts,
      user: opts.user || req.session.user,
      ip: req.ip || req.connection.remoteAddress
    });
  };
  next();
}

module.exports = { logActivity, auditMiddleware };
