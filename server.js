const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const flash = require('connect-flash');
const ejsLayouts = require('express-ejs-layouts');
const path = require('path');
const { initializeDatabase } = require('./db/schema');
const { requireLogin } = require('./middleware/auth');
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

// Flash messages available in all templates
app.use((req, res, next) => {
  res.locals.flash_success = req.flash('success');
  res.locals.flash_error = req.flash('error');
  res.locals.user = req.session.user || null;
  next();
});

// Notification count available in all templates (header bell badge)
app.use(notificationCountMiddleware);

// Routes
app.use('/', require('./routes/auth'));
app.use('/dashboard', requireLogin, require('./routes/dashboard'));
app.use('/jobs', requireLogin, require('./routes/jobs'));
app.use('/tasks', requireLogin, require('./routes/tasks'));
app.use('/updates', requireLogin, require('./routes/updates'));
app.use('/compliance', requireLogin, require('./routes/compliance'));
app.use('/incidents', requireLogin, require('./routes/incidents'));
app.use('/contacts', requireLogin, require('./routes/contacts'));
app.use('/documents', requireLogin, require('./routes/documents'));
app.use('/activity', requireLogin, require('./routes/activity'));
app.use('/budgets', requireLogin, require('./routes/budgets'));
app.use('/timesheets', requireLogin, require('./routes/timesheets'));
app.use('/schedule', requireLogin, require('./routes/schedule'));
app.use('/equipment', requireLogin, require('./routes/equipment'));
app.use('/defects', requireLogin, require('./routes/defects'));
app.use('/notifications', requireLogin, require('./routes/notifications'));
app.use('/admin', requireLogin, require('./routes/admin'));

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
  console.log(`T&S Dashboard running at http://localhost:${PORT}`);
  console.log(`Default login: admin / admin123`);

  // Generate notifications on startup and every 15 minutes
  generateNotifications();
  setInterval(generateNotifications, 15 * 60 * 1000);
});
