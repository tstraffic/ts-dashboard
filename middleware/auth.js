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
  // ── Shared ──
  dashboard:     ['admin', 'operations', 'planning', 'finance', 'hr', 'sales', 'management', 'marketing', 'accounts'],
  jobs:          ['admin', 'operations', 'planning', 'finance', 'sales', 'management'],
  projects:      ['admin', 'operations', 'planning', 'finance', 'sales', 'management'],
  clients:       ['admin', 'operations', 'planning', 'finance', 'hr', 'sales', 'management', 'marketing', 'accounts'],
  notifications: ['admin', 'operations', 'planning', 'finance', 'hr', 'sales', 'management', 'marketing', 'accounts'],

  // ── Operations only (no planning) ──
  tasks:         ['admin', 'operations', 'planning'],  // planning sees only their own + plan-linked tasks
  incidents:     ['admin', 'operations'],
  contacts:      ['admin', 'operations', 'hr', 'sales'],
  timesheets:    ['admin', 'operations', 'finance'],
  crew:          ['admin', 'operations'],
  allocations:   ['admin', 'operations'],
  schedule:      ['admin', 'operations'],
  equipment:     ['admin', 'operations'],
  defects:       ['admin', 'operations'],
  documents:     ['admin', 'operations', 'finance'],
  bookings:      ['admin', 'operations'],
  reports:       ['admin', 'operations', 'finance', 'hr', 'sales', 'management', 'accounts'],
  exports:       ['admin', 'operations', 'finance', 'hr', 'sales', 'management', 'accounts'],

  // ── Planning only (no operations) ──
  compliance:    ['admin', 'planning'],
  plans:         ['admin', 'planning'],
  updates:       ['admin', 'planning'],

  // ── Site audits (safety/ops/planning/admin) ──
  audits:        ['admin', 'operations', 'planning', 'management'],

  // ── Checklist templates (admin/planning manage templates, ops can view) ──
  checklists:    ['admin', 'operations', 'planning'],

  // ── Finance / Admin ──
  budgets:       ['admin', 'finance'],
  crm:           ['admin'],
  admin:         ['admin'],
  activity:      ['admin'],
  settings:      ['admin', 'planning'],

  // ── Dual-view: Planning job tabs ──
  planning_plans:     ['admin', 'planning'],              // full plan workspace (drafts, revisions, mark final)
  planning_diary:     ['admin', 'planning', 'operations'],// site diary (both views)
  planning_chat:      ['admin', 'planning'],              // job-level chat

  // ── Dual-view: Operations job tabs ──
  ops_final_plans:    ['admin', 'operations'],            // read-only final plans
  ops_tasks:          ['admin', 'operations'],            // tasks (ops only)
  ops_timesheets:     ['admin', 'operations', 'finance'], // timesheet entry
  ops_incidents:      ['admin', 'operations'],            // incident reporting
  ops_flag:           ['admin', 'operations'],            // flag for review on final plans

  // ── Induction ──
  induction:          ['admin', 'operations', 'hr'],

  // ── HR modules ──
  hr_dashboard:       ['admin', 'hr'],
  hr_employees:       ['admin', 'hr'],
  hr_documents:       ['admin', 'hr'],
  hr_competencies:    ['admin', 'hr'],
  hr_reports:         ['admin', 'hr'],
  hr_settings:        ['admin'],
  hr_compliance_view: ['admin', 'hr', 'operations'],
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
