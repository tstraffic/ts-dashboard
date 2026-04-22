// Admin-division task visibility rules.
// Tasks filed under division='admin' are private to the admin team —
// management wants a place to track personal / internal items without
// every employee seeing them in lists and badges.
const ADMIN_ROLES = new Set(['admin', 'management']);

function isAdminRole(user) {
  if (!user) return false;
  return ADMIN_ROLES.has((user.role || '').toLowerCase());
}

// Returns a SQL fragment to AND into any WHERE clause that reads from the
// tasks table. Empty string for admin/management users (no filter); the
// division != 'admin' guard for everyone else. Pass the alias the tasks
// table was given in the query (defaults to 't').
function hideAdminTasksSql(user, alias = 't') {
  if (isAdminRole(user)) return '';
  return ` AND ${alias}.division != 'admin'`;
}

module.exports = { ADMIN_ROLES, isAdminRole, hideAdminTasksSql };
