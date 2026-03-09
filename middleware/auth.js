// Authentication and role-based access middleware

// ---- Centralised Permission Map ----
// Single source of truth: which roles can access which modules.
// Management always has full access. Crew uses separate portal.
const PERMISSIONS = {
  dashboard:     ['management', 'operations', 'planning', 'marketing', 'accounts'],
  jobs:          ['management', 'operations', 'planning', 'marketing', 'accounts'],
  projects:      ['management', 'operations', 'planning', 'marketing', 'accounts'],
  clients:       ['management', 'operations', 'planning', 'marketing', 'accounts'],
  tasks:         ['management', 'operations', 'planning'],
  updates:       ['management', 'operations', 'planning', 'marketing'],
  compliance:    ['management', 'operations', 'planning'],
  plans:         ['management', 'planning'],
  incidents:     ['management', 'operations'],
  contacts:      ['management', 'operations', 'marketing'],
  timesheets:    ['management', 'operations', 'accounts'],
  crew:          ['management', 'operations', 'planning'],
  allocations:   ['management', 'operations', 'planning'],
  schedule:      ['management', 'operations', 'planning'],
  equipment:     ['management', 'operations'],
  defects:       ['management', 'operations'],
  documents:     ['management', 'operations', 'planning', 'accounts'],
  budgets:       ['management', 'accounts'],
  reports:       ['management', 'operations', 'planning', 'accounts'],
  exports:       ['management', 'operations', 'planning', 'accounts'],
  notifications: ['management', 'operations', 'planning', 'marketing', 'accounts'],
  admin:         ['management'],
  activity:      ['management'],
  settings:      ['management'],
};

// ---- Helpers ----

/** Check if a user can access a given module (for templates / sidebar) */
function canAccess(user, module) {
  if (!user || !user.role) return false;
  const allowed = PERMISSIONS[module];
  if (!allowed) return false; // unknown module = deny
  return allowed.includes(user.role);
}

/** Express middleware: require permission for a module */
function requirePermission(module) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (canAccess(req.session.user, module)) {
      return next();
    }
    res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You do not have permission to access this resource.',
      user: req.session.user
    });
  };
}

// ---- Existing middleware ----

function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.user = req.session.user;
    return next();
  }
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (roles.includes(req.session.user.role)) {
      return next();
    }
    res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You do not have permission to access this resource.',
      user: req.session.user
    });
  };
}

function requireAccountsAccess(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  const role = req.session.user.role;
  if (role === 'accounts' || role === 'management') {
    return next();
  }
  res.status(403).render('error', {
    title: 'Access Denied',
    message: 'Accounts documents are restricted to Accounts and Management only.',
    user: req.session.user
  });
}

function canViewAccounts(user) {
  return user && (user.role === 'accounts' || user.role === 'management');
}

module.exports = { requireLogin, requireRole, requirePermission, requireAccountsAccess, canViewAccounts, canAccess, PERMISSIONS };
