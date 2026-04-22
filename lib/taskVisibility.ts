// Admin-division task visibility rules.
// Tasks filed under division='admin' are private to the admin team —
// management wants a place to track personal / internal items without
// every employee seeing them in lists and badges.

/** Shape of the user object this module cares about. Sessions pass more
 *  fields, but this helper only reads `role`. */
export interface UserLike {
  role?: string | null;
}

export const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin', 'management']);

export function isAdminRole(user: UserLike | null | undefined): boolean {
  if (!user) return false;
  return ADMIN_ROLES.has((user.role || '').toLowerCase());
}

/**
 * SQL fragment to AND into any WHERE clause that reads from the tasks
 * table. Empty string for admin/management users (no filter); the
 * `division != 'admin'` guard for everyone else. Pass the alias the tasks
 * table was given in the query (defaults to 't').
 */
export function hideAdminTasksSql(
  user: UserLike | null | undefined,
  alias: string = 't'
): string {
  if (isAdminRole(user)) return '';
  return ` AND ${alias}.division != 'admin'`;
}

// CommonJS interop — existing routes use `require('../lib/taskVisibility')`
// and destructure by name. Keep that working until every caller migrates.
module.exports = { ADMIN_ROLES, isAdminRole, hideAdminTasksSql };
