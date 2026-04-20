// Manager gate for the worker portal — only workers with crew_members.is_manager = 1
// (set via admin UI or migration 123) can hit /w/manage/* routes.

const { getDb } = require('../db/database');

function isManager(worker) {
  if (!worker || !worker.id) return false;
  try {
    const row = getDb().prepare('SELECT is_manager FROM crew_members WHERE id = ?').get(worker.id);
    return !!(row && row.is_manager);
  } catch (e) { return false; }
}

function requireManager(req, res, next) {
  if (!req.session.worker) {
    req.session.workerReturnTo = req.originalUrl;
    return res.redirect('/w/login');
  }
  if (!isManager(req.session.worker)) {
    req.flash('error', 'Manager access required.');
    return res.redirect('/w/home');
  }
  next();
}

// Expose to templates so the view can show/hide the Manage card
function managerLocals(req, res, next) {
  res.locals.isManager = isManager(req.session.worker);
  next();
}

module.exports = { isManager, requireManager, managerLocals };
