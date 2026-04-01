// Sidebar badge counts — lightweight middleware, cached for 60 seconds
const { getDb } = require('../db/database');

let cache = { data: null, expires: 0 };

function safeCount(db, sql, params) {
  try { return db.prepare(sql).get(...(params || [])).c; }
  catch (e) { return 0; }
}

function sidebarBadges(req, res, next) {
  if (!req.session || !req.session.user) return next();

  const now = Date.now();
  if (cache.data && now < cache.expires) {
    res.locals.sidebarBadges = cache.data;
    return next();
  }

  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const next30 = new Date(now + 30 * 86400000).toISOString().split('T')[0];

    const badges = {
      allocations: safeCount(db, "SELECT COUNT(*) as c FROM crew_allocations WHERE allocation_date = ? AND status = 'allocated'", [today]),
      tasks: safeCount(db, "SELECT COUNT(*) as c FROM tasks WHERE status != 'complete'"),
      incidents: safeCount(db, "SELECT COUNT(*) as c FROM incidents WHERE investigation_status NOT IN ('closed', 'resolved')"),
      defects: safeCount(db, "SELECT COUNT(*) as c FROM defects WHERE status NOT IN ('closed', 'deferred')"),
      crew: safeCount(db, `
        SELECT COUNT(*) as c FROM crew_members WHERE active = 1 AND (
          (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
          OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
          OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
          OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
          OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
        )
      `, [today, next30, today, next30, today, next30, today, next30, today, next30]),
      compliance: safeCount(db, "SELECT COUNT(*) as c FROM compliance WHERE status NOT IN ('approved','expired')", []),
    };

    cache = { data: badges, expires: now + 60000 };
    res.locals.sidebarBadges = badges;
  } catch (e) {
    res.locals.sidebarBadges = {};
  }
  next();
}

module.exports = { sidebarBadges };
