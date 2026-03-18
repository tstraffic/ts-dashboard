const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const flash = require('connect-flash');
const ejsLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initializeDatabase } = require('./db/schema');
const { requireLogin, requirePermission, canAccess } = require('./middleware/auth');
const { requireWorker, blockWorkerFromAdmin, workerLocals } = require('./middleware/workerAuth');
const { notificationCountMiddleware, generateNotifications, sendDailyDigests } = require('./middleware/notifications');
const { settingsMiddleware } = require('./middleware/settings');
const { sidebarBadges } = require('./middleware/sidebarBadges');
const { initVapid } = require('./services/pushNotification');

// Initialize database and seed data
initializeDatabase();

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', true);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for Tailwind CDN + inline scripts
  crossOriginEmbedderPolicy: false,
}));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions (secure cookies in production)
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'ts-traffic-dashboard-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
  }
}));

// Trust proxy for Railway (needed for secure cookies behind load balancer)
if (isProduction) app.set('trust proxy', 1);

app.use(flash());

// Flash messages + permission helper available in all templates
app.use((req, res, next) => {
  res.locals.flash_success = req.flash('success');
  res.locals.flash_error = req.flash('error');
  res.locals.user = req.session.user || null;
  res.locals.canAccess = canAccess;
  next();
});

// Notification count available in all templates (header bell badge)
app.use(notificationCountMiddleware);

// Settings available in all templates (dropdown options, system config)
app.use(settingsMiddleware);

// Sidebar badge counts (cached 60s)
app.use(sidebarBadges);

// Public invite/setup routes (no auth required, must be BEFORE blockWorkerFromAdmin)
app.use('/invite', require('./routes/invite'));
app.use('/w/setup', require('./routes/worker/setup'));
// Induction admin routes (must be BEFORE public /induction/:type to avoid catch-all)
app.use('/induction/admin', requireLogin, requirePermission('induction'), require('./routes/induction-admin'));
app.use('/induction', require('./routes/induction'));

// Rate limiting on login endpoints (prevent brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: 'Too many login attempts, please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/login', loginLimiter);
app.post('/w/login', loginLimiter);

// Worker Portal routes (must be BEFORE blockWorkerFromAdmin)
app.use('/w', require('./routes/worker/auth'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/home'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/jobs'));

// Block worker-only sessions from admin routes
app.use(blockWorkerFromAdmin);

// Routes (auth is public, everything else requires login + permission)
app.use('/', require('./routes/auth'));
app.use('/profile', requireLogin, require('./routes/profile'));
app.use('/dashboard', requireLogin, requirePermission('dashboard'), require('./routes/dashboard'));
app.use('/projects', requireLogin, requirePermission('projects'), require('./routes/projects'));
app.use('/clients', requireLogin, requirePermission('clients'), require('./routes/clients'));
app.use('/jobs', requireLogin, requirePermission('jobs'), require('./routes/jobs'));
app.use('/tasks', requireLogin, requirePermission('tasks'), require('./routes/tasks'));
app.use('/updates', requireLogin, requirePermission('updates'), require('./routes/updates'));
app.use('/compliance', requireLogin, requirePermission('compliance'), require('./routes/compliance'));
app.use('/plans', requireLogin, requirePermission('plans'), require('./routes/plans'));
app.use('/incidents', requireLogin, requirePermission('incidents'), require('./routes/incidents'));
app.use('/contacts', requireLogin, requirePermission('contacts'), require('./routes/contacts'));
app.use('/documents', requireLogin, requirePermission('documents'), require('./routes/documents'));
app.use('/activity', requireLogin, requirePermission('activity'), require('./routes/activity'));
app.use('/budgets', requireLogin, requirePermission('budgets'), require('./routes/budgets'));
app.use('/timesheets', requireLogin, requirePermission('timesheets'), require('./routes/timesheets'));
app.use('/crew', requireLogin, requirePermission('crew'), require('./routes/crew'));
app.use('/bookings', requireLogin, requirePermission('bookings'), require('./routes/bookings'));
app.use('/allocations', requireLogin, requirePermission('allocations'), require('./routes/allocations'));
app.use('/schedule', requireLogin, requirePermission('schedule'), require('./routes/schedule'));
app.use('/equipment', requireLogin, requirePermission('equipment'), require('./routes/equipment'));
app.use('/exports', requireLogin, requirePermission('exports'), require('./routes/exports'));
app.use('/reports', requireLogin, requirePermission('reports'), require('./routes/reports'));
app.use('/defects', requireLogin, requirePermission('defects'), require('./routes/defects'));
app.use('/hr', requireLogin, require('./routes/hr'));
app.use('/crm', requireLogin, requirePermission('crm'), require('./routes/crm'));
app.use('/opportunities', requireLogin, requirePermission('crm'), require('./routes/opportunities'));
app.use('/notifications', requireLogin, requirePermission('notifications'), require('./routes/notifications'));
app.use('/admin/integrations', requireLogin, requirePermission('admin'), require('./routes/integrations'));
app.use('/admin', requireLogin, requirePermission('admin'), require('./routes/admin'));
app.use('/settings', requireLogin, requirePermission('settings'), require('./routes/settings'));
app.use('/api/views', requireLogin, require('./routes/saved-views'));

// Home redirects to dashboard or worker portal
app.get('/', (req, res) => {
  if (req.session.worker) return res.redirect('/w/home');
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  // If on a worker path, render worker error page
  if (req.path.startsWith('/w') && req.session && req.session.worker) {
    return res.status(404).render('worker/error', {
      layout: 'worker/layout',
      title: '404 Not Found',
      message: 'The page you are looking for does not exist.',
      worker: req.session.worker,
      currentPage: '',
    });
  }
  res.status(404).render('error', {
    title: '404 Not Found',
    message: 'The page you are looking for does not exist.',
    user: req.session.user || null
  });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  // Worker routes get worker error page
  if (req.path.startsWith('/w') && req.session && req.session.worker) {
    return res.status(500).render('worker/error', {
      layout: 'worker/layout',
      title: 'Server Error',
      message: 'Something went wrong. Please try again.',
      worker: req.session.worker,
      currentPage: '',
    });
  }
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again.',
    user: req.session.user || null
  });
});

app.listen(PORT, () => {
  console.log(`T&S Operations Dashboard running at http://localhost:${PORT}`);
  if (!isProduction) console.log(`Dev login: admin / admin123`);

  // Initialize web push VAPID keys
  initVapid();

  // Generate notifications on startup and every 15 minutes
  generateNotifications();
  setInterval(generateNotifications, 15 * 60 * 1000);

  // Daily digest emails — check every 15 min, send at 7:00 AM
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 7 && now.getMinutes() < 15) {
      console.log('Sending daily digest emails...');
      sendDailyDigests();
    }
  }, 15 * 60 * 1000);
});
