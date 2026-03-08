# Permissions & Roles — Implementation Plan

## Approach
Centralised permission map in `middleware/auth.js`. No new DB tables — permissions defined in code, applied via route-level middleware and sidebar rendering.

## Permission Map (single source of truth)

```js
const PERMISSIONS = {
  dashboard:   ['management', 'operations', 'planning', 'marketing', 'accounts'],
  jobs:        ['management', 'operations', 'planning', 'marketing', 'accounts'], // all office roles
  tasks:       ['management', 'operations', 'planning'],
  updates:     ['management', 'operations', 'planning', 'marketing'],
  compliance:  ['management', 'operations', 'planning'],
  plans:       ['management', 'planning'],
  incidents:   ['management', 'operations'],
  contacts:    ['management', 'operations', 'marketing'],
  timesheets:  ['management', 'operations', 'accounts'],
  allocations: ['management', 'operations'],
  schedule:    ['management', 'operations', 'planning'],
  equipment:   ['management', 'operations'],
  defects:     ['management', 'operations'],
  documents:   ['management', 'operations', 'planning', 'accounts'],
  budgets:     ['management', 'accounts'],
  reports:     ['management', 'operations', 'planning', 'accounts'],
  exports:     ['management', 'operations', 'planning', 'accounts'],
  notifications: ['management', 'operations', 'planning', 'marketing', 'accounts'],
  admin:       ['management'],
  activity:    ['management'],
};
```

**Key decisions:**
- **Management** = full access (super admin)
- **Operations** = field ops: jobs, crew, timesheets, allocations, equipment, incidents, defects, schedule
- **Planning** = project planning: jobs, tasks, compliance, plans, documents, schedule
- **Marketing** = client-facing: jobs (read), contacts, updates
- **Accounts** = financial: jobs (read), budgets, timesheets (read), documents
- **Jobs** open to all office roles (everyone needs visibility)
- **Crew** stays separate (crew portal, not affected by this)

## Files to Modify

### 1. `middleware/auth.js`
- Add `PERMISSIONS` map object
- Add `requirePermission(module)` middleware — looks up module in map, checks user role
- Add `canAccess(user, module)` helper — for sidebar/template checks
- Export both + existing functions

### 2. `server.js` (~15 route lines)
- Replace bare `requireLogin` with `requireLogin, requirePermission('module')` on each route
- Example: `app.use('/incidents', requireLogin, requirePermission('incidents'), require('./routes/incidents'));`
- Routes that already have `requireRole()` inside their files keep working (belt + suspenders)

### 3. `views/partials/sidebar.ejs`
- Replace scattered `if (user.role === ...)` checks with `canAccess(user, 'module')` calls
- Every sidebar link wrapped in `<% if (canAccess(user, 'module')) { %>`
- `canAccess` passed to all templates via middleware

### 4. Flash middleware in `server.js`
- Add `res.locals.canAccess = canAccess;` so all templates can use it

### 5. `routes/exports.js`
- Budget/cost CSV exports already check `canViewAccounts()` — no changes needed
- Other exports inherit permission from the `/exports` route guard

## What This Does NOT Change
- No new database tables or migrations
- No changes to existing route logic inside route files
- No changes to how `requireRole()` works inside individual routes (e.g. timesheet approval)
- Crew portal unchanged
- Existing `canViewAccounts()` stays (used for financial data within views)

## Testing
- Log in as each role (admin, ops_user, planning_user, marketing_user, accounts_user)
- Verify correct sidebar links shown
- Verify direct URL access returns 403 for restricted routes
- Verify management still has full access
