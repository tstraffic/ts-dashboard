// Worker Portal authentication and authorization middleware

/**
 * Require an authenticated worker session.
 * Redirects to /w/login if no worker session exists.
 */
function requireWorker(req, res, next) {
  if (req.session && req.session.worker) {
    return next();
  }
  req.session.workerReturnTo = req.originalUrl;
  res.redirect('/w/login');
}

/**
 * Ensure the worker can only access their own data.
 * Compares req.params[paramName] against req.session.worker.id.
 */
function requireOwnData(paramName) {
  return (req, res, next) => {
    if (!req.session || !req.session.worker) {
      return res.redirect('/w/login');
    }
    if (String(req.params[paramName]) !== String(req.session.worker.id)) {
      return res.status(403).render('worker/error', {
        layout: 'worker/layout',
        title: 'Access Denied',
        message: 'You can only view your own records.',
        worker: req.session.worker,
      });
    }
    next();
  };
}

/**
 * Block worker-only sessions from accessing admin routes.
 * If user has a worker session but NO admin session, redirect to worker home.
 * Must be mounted BEFORE admin route handlers.
 */
function blockWorkerFromAdmin(req, res, next) {
  // Skip for worker routes (they start with /w)
  if (req.path.startsWith('/w')) return next();
  // Skip for static assets and login
  if (req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/images') || req.path === '/login' || req.path === '/manifest.json') return next();

  // If worker session exists but no admin session, redirect to worker portal
  if (req.session && req.session.worker && !req.session.user) {
    return res.redirect('/w/home');
  }
  next();
}

/**
 * Set worker-specific template locals.
 * Sets res.locals.worker and overrides layout to worker/layout.
 */
function workerLocals(req, res, next) {
  res.locals.worker = req.session.worker || null;
  res.locals.layout = 'worker/layout';
  // Also set flash messages for worker views
  res.locals.flash_success = req.flash('success');
  res.locals.flash_error = req.flash('error');
  next();
}

module.exports = { requireWorker, requireOwnData, blockWorkerFromAdmin, workerLocals };
