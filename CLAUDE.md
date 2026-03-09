# T&S Operations Dashboard — Project Context

## Overview
Full-stack operations management platform for **T&S Traffic Control** (Sydney traffic management company). Two interfaces in a single codebase:

1. **Admin Dashboard** — Desktop web app for office staff (management, operations, admin roles)
2. **Worker Portal** — Mobile-first PWA for field crew members (under `/w/` prefix)

## Tech Stack
- **Backend**: Node.js, Express, EJS templates, express-ejs-layouts
- **Database**: SQLite via better-sqlite3
- **Frontend**: Tailwind CSS (CDN), vanilla JS
- **Auth**: Admin = username/password (bcrypt). Worker = Employee ID + numeric PIN (bcrypt)
- **Node path on this machine**: `PATH="/c/Program Files/nodejs:$PATH"` (required for all node/npm commands)
- **GitHub repo**: `tstraffic/ts-dashboard` (origin)

## Brand Colors
- Primary: `#2B7FFF` (brand-600: `#1D6AE5`)
- Full scale: brand-50 through brand-950 defined in Tailwind config
- Light enterprise theme (white/gray backgrounds, colored accents)

## Architecture
- **Admin routes**: `/dashboard`, `/jobs`, `/crew`, `/allocations`, etc. Protected by `req.session.user`
- **Worker routes**: `/w/home`, `/w/jobs`, `/w/jobs/:id`, etc. Protected by `req.session.worker`
- **Session isolation**: `req.session.worker` is separate from `req.session.user`. Both can coexist
- **Layout override**: Admin uses `views/layout.ejs` (default). Worker uses `views/worker/layout.ejs` via `res.locals.layout`
- **`blockWorkerFromAdmin`** middleware prevents worker-only sessions from accessing admin routes

## Database Migrations
14 migrations in `db/schema.js`. Migration 14 = Worker Portal auth columns on `crew_members`:
- `pin_hash`, `pin_set_at`, `pin_set_by_id`, `last_worker_login`, `worker_login_count`

## Key Middleware
- `middleware/auth.js` — Admin auth (`requireAuth`, `requireRole`)
- `middleware/workerAuth.js` — Worker auth (`requireWorker`, `requireOwnData`, `blockWorkerFromAdmin`, `workerLocals`)
- `middleware/compliance.js` — Ticket/licence/fatigue compliance checks (`getComplianceStatus`, `getComplianceStatusBatch`, `getBatchFatigue`)
- `middleware/audit.js` — Activity logging (`logActivity`)
- `middleware/settings.js` — System settings

## Test Data
- Admin: username `admin` / password `admin123`
- Worker: Employee ID `EMP-001` / PIN `1234` (John Smith, crew_member id=1)

---

## Completed Work

### UI Rebrand (completed)
- Migrated all 52+ EJS views from dark to light enterprise theme
- T&S brand colors throughout
- Added compliance middleware, crew management views, settings system, enhanced allocation/incident routes

### Worker Portal Sprint 1 (completed)
- **Auth**: Employee ID + PIN login, logout, session management
- **Home screen**: Time-based greeting, today's shift card, compliance alerts, quick actions
- **My Jobs**: List view (today + 7 days grouped by date), job detail (supervisor, crew, site info)
- **PWA foundation**: manifest.json, service worker (network-first caching), worker.css, worker.js
- **Admin PIN management**: Set/reset/clear PIN from crew profile page, login tracking
- **Files created**: 15 new files (middleware, routes, views, PWA assets)
- **Files modified**: server.js, db/schema.js, routes/crew.js, views/crew/show.ejs
- **PR**: Merged via `claude/eloquent-booth` branch

---

## Upcoming Sprints

### Sprint 2: Clock In/Out + Availability
- **Clock In/Out system**: GPS-stamped clock in/out from worker portal, linked to crew_allocations
- **Availability submission**: Workers can submit availability/unavailability for upcoming dates
- **Database**: New tables or columns for clock events and availability records
- **Views**: Clock in/out UI on worker home + dedicated clock page, availability calendar/form
- **Admin side**: View clock events on allocation detail, availability visible on scheduling views

### Sprint 3: Prestart/Fatigue Declaration + Incident Reporting
- **Prestart checklist**: Workers complete a prestart safety checklist before starting work
- **Fatigue declaration**: Workers declare fatigue status (integrates with existing fatigue compliance)
- **Incident reporting**: Workers can submit incident reports from the field (photos, description, severity)
- **Database**: New tables for prestarts, fatigue declarations; leverage existing incidents table
- **Views**: Prestart form, fatigue declaration form, incident report form (all mobile-optimized)

### Sprint 4: Timesheet Auto-Generation + Supervisor Approvals
- **Timesheet auto-generation**: Generate timesheets from clock in/out data
- **Supervisor approvals**: Supervisors can review and approve timesheets, prestarts
- **Push to admin**: Approved timesheets flow into the existing admin timesheet system
- **Views**: Timesheet review screens, approval workflows

### Sprint 5: Mobile Polish + PWA Install + Notifications
- **PWA install prompts**: Proper install flow with app icons and splash screens
- **Push notifications**: Shift reminders, approval notifications (web push or similar)
- **Offline support**: Enhanced service worker for offline prestart/clock forms
- **UI polish**: Animations, transitions, loading states, error recovery
- **Performance**: Optimize queries, add indexes if needed

---

## File Structure (Worker Portal)
```
middleware/workerAuth.js
routes/worker/auth.js        — Login/logout
routes/worker/home.js        — Home screen
routes/worker/jobs.js        — Jobs list + detail
views/worker/layout.ejs      — Mobile shell + bottom tab nav
views/worker/login.ejs       — Standalone login page
views/worker/home.ejs        — Home screen
views/worker/jobs.ejs        — Jobs list
views/worker/job-detail.ejs  — Job detail
views/worker/error.ejs       — Error page
public/manifest.json
public/css/worker.css
public/js/worker.js
public/js/worker-sw.js
```

## Bottom Tab Nav (Worker Portal)
4 tabs: Home (house), Jobs (briefcase), Clock (clock), Profile (user)
- Home + Jobs = Sprint 1 (done)
- Clock = Sprint 2 (next)
- Profile = Sprint 5 (future)
