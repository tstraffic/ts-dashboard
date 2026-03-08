const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const flash = require('connect-flash');
const ejsLayouts = require('express-ejs-layouts');
const path = require('path');
const { initializeDatabase } = require('./db/schema');
const { requireLogin, requirePermission, canAccess } = require('./middleware/auth');
const { notificationCountMiddleware, generateNotifications } = require('./middleware/notifications');

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

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'ts-traffic-dashboard-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

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

// Routes (auth is public, everything else requires login + permission)
app.use('/', require('./routes/auth'));
app.use('/dashboard', requireLogin, requirePermission('dashboard'), require('./routes/dashboard'));
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
app.use('/allocations', requireLogin, requirePermission('allocations'), require('./routes/allocations'));
app.use('/schedule', requireLogin, requirePermission('schedule'), require('./routes/schedule'));
app.use('/equipment', requireLogin, requirePermission('equipment'), require('./routes/equipment'));
app.use('/exports', requireLogin, requirePermission('exports'), require('./routes/exports'));
app.use('/reports', requireLogin, requirePermission('reports'), require('./routes/reports'));
app.use('/defects', requireLogin, requirePermission('defects'), require('./routes/defects'));
app.use('/notifications', requireLogin, requirePermission('notifications'), require('./routes/notifications'));
app.use('/admin/integrations', requireLogin, requirePermission('admin'), require('./routes/integrations'));
app.use('/admin', requireLogin, requirePermission('admin'), require('./routes/admin'));

// Home redirects to dashboard
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 Not Found',
    message: 'The page you are looking for does not exist.',
    user: req.session.user || null
  });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again.',
    user: req.session.user || null
  });
});

app.listen(PORT, () => {
  console.log(`T&S Operations Dashboard running at http://localhost:${PORT}`);
  console.log(`Default login: admin / admin123`);

  // Generate notifications on startup and every 15 minutes
  generateNotifications();
  setInterval(generateNotifications, 15 * 60 * 1000);
});
