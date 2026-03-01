// Authentication and role-based access middleware

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

module.exports = { requireLogin, requireRole, requireAccountsAccess, canViewAccounts };
