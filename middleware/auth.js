// Authentication and role-based access middleware

// ---- Role Aliases ----
// Maps legacy DB role names to current role names.
// SQLite CHECK constraints prevent renaming in existing databases,
// so we normalise at runtime instead.
const ROLE_ALIASES = {
  management: 'admin',
  accounts:   'finance',
  marketing:  'operations',
};

/** Normalise a role: convert legacy names to current ones */
function normaliseRole(role) {
  return ROLE_ALIASES[role] || role;
}

// ---- Centralised Permission Map ----
// Single source of truth: which roles can access which modules.
// Admin always has full access. Crew uses separate portal.
// Roles: admin (full), operations (no finance), planning (no finance), finance (finance + reporting),
//        hr (HR modules + limited ops), sales (CRM + limited ops)
const PERMISSIONS = {
  dashboard:     ['admin', 'operations', 'planning', 'finance', 'hr', 'sales'],
  jobs:          ['admin', 'operations', 'planning', 'finance', 'sales'],
  projects:      ['admin', 'operations', 'planning', 'finance', 'sales'],
  clients:       ['admin', 'operations', 'planning', 'finance', 'sales'],
  tasks:         ['admin', 'operations', 'planning'],
  updates:       ['admin', 'operations', 'planning'],
  compliance:    ['admin', 'operations', 'planning'],
  plans:         ['admin', 'operations', 'planning'],
  incidents:     ['admin', 'operations', 'planning'],
  contacts:      ['admin', 'operations', 'planning', 'hr', 'sales'],
  timesheets:    ['admin', 'operations', 'planning', 'finance'],
  crew:          ['admin', 'operations', 'planning'],
  allocations:   ['admin', 'operations', 'planning'],
  schedule:      ['admin', 'operations', 'planning'],
  equipment:     ['admin', 'operations', 'planning'],
  defects:       ['admin', 'operations', 'planning'],
  documents:     ['admin', 'operations', 'planning', 'finance'],
  budgets:       ['admin', 'finance'],
  reports:       ['admin', 'operations', 'planning', 'finance', 'hr', 'sales'],
  exports:       ['admin', 'operations', 'planning', 'finance', 'hr', 'sales'],
  notifications: ['admin', 'operations', 'planning', 'finance', 'hr', 'sales'],
  bookings:      ['admin', 'operations', 'planning'],
  crm:           ['admin', 'operations', 'planning', 'sales'],
  admin:         ['admin'],
  activity:      ['admin'],
  settings:      ['admin'],
  // Induction
  induction:          ['admin', 'operations', 'hr'],
  // HR modules
  hr_dashboard:       ['admin', 'hr'],
  hr_employees:       ['admin', 'hr'],
  hr_documents:       ['admin', 'hr'],
  hr_competencies:    ['admin', 'hr'],
  hr_reports:         ['admin', 'hr'],
  hr_settings:        ['admin'],
  hr_compliance_view: ['admin', 'hr', 'operations', 'planning'],
};

// ---- Helpers ----

/** Check if a user can access a given module (for templates / sidebar) */
function canAccess(user, module) {
  if (!user || !user.role) return false;
  const allowed = PERMISSIONS[module];
  if (!allowed) return false; // unknown module = deny
  return allowed.includes(normaliseRole(user.role));
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
    // Normalise legacy role in session so templates see current name
    req.session.user.role = normaliseRole(req.session.user.role);
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
    if (roles.includes(normaliseRole(req.session.user.role))) {
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
  const role = normaliseRole(req.session.user.role);
  if (role === 'finance' || role === 'admin') {
    return next();
  }
  res.status(403).render('error', {
    title: 'Access Denied',
    message: 'Accounts documents are restricted to Finance and Admin only.',
    user: req.session.user
  });
}

function canViewAccounts(user) {
  if (!user) return false;
  const role = normaliseRole(user.role);
  return role === 'finance' || role === 'admin';
}

/** Check if user can view sensitive HR data (DOB, emergency contacts, disciplinary, etc.) */
function canViewSensitiveHR(user) {
  if (!user) return false;
  const role = normaliseRole(user.role);
  return role === 'admin' || role === 'hr';
}

module.exports = { requireLogin, requireRole, requirePermission, requireAccountsAccess, canViewAccounts, canViewSensitiveHR, canAccess, normaliseRole, PERMISSIONS };
