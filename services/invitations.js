const crypto = require('crypto');
const { getDb } = require('../db/database');

const TOKEN_EXPIRY_HOURS = 72;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createInvitation({ type, targetId, email, createdById }) {
  const db = getDb();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO invitations (type, target_id, token, email, expires_at, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(type, targetId, token, email, expiresAt, createdById);
  return { token, expiresAt };
}

function validateToken(token, type) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM invitations
    WHERE token = ? AND type = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(token, type);
}

function markTokenUsed(token) {
  const db = getDb();
  db.prepare('UPDATE invitations SET used_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
}

module.exports = { createInvitation, validateToken, markTokenUsed, TOKEN_EXPIRY_HOURS };
