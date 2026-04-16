const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requirePermission, canViewSensitiveHR } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { workerInviteEmail } = require('../services/emailTemplates');

// Only admin and finance can see pay rates
function canViewRates(user) {
  const role = (user.role || '').toLowerCase();
  return role === 'admin' || role === 'finance';
}

// --- Multer config for HR document uploads ---
const UPLOAD_BASE = path.join(__dirname, '..', 'data', 'uploads', 'hr');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const empId = req.params.id || 'unknown';
    const docType = req.body.document_type || 'other';
    const dir = path.join(UPLOAD_BASE, `emp_${empId}`, docType);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const ALLOWED_HR_FILES = /\.(pdf|doc|docx|xls|xlsx|png|jpg|jpeg|gif|csv|txt|zip)$/i;
const hrFileFilter = (req, file, cb) => {
  if (ALLOWED_HR_FILES.test(file.originalname)) cb(null, true);
  else cb(new Error('File type not allowed'), false);
};
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: hrFileFilter });

// --- Readiness computation ---
function computeReadiness(employee, competencies, documents) {
  if (employee.employment_status === 'offboarded') return { status: 'offboarded', color: 'gray' };
  if (employee.employment_status === 'on_leave') return { status: 'on_leave', color: 'blue' };
  if (employee.employment_status === 'onboarding') return { status: 'onboarding', color: 'purple' };
  if (employee.employment_status === 'suspended') return { status: 'blocked', color: 'red' };
  if (employee.blocked_from_allocation) return { status: 'blocked', color: 'red' };

  const expiredMandatory = (competencies || []).filter(c => c.mandatory_for_role && (c.status === 'expired' || c.status === 'missing'));
  const missingMandatoryDocs = (documents || []).filter(d => d.mandatory && d.verification_status !== 'verified');

  if (expiredMandatory.length > 0 || missingMandatoryDocs.length > 0) return { status: 'non_compliant', color: 'red' };

  const expiringSoon = (competencies || []).filter(c => c.status === 'expiring_soon');
  if (expiringSoon.length > 0) return { status: 'ready_with_warnings', color: 'amber' };

  return { status: 'ready', color: 'green' };
}

// Auto-compute competency status based on expiry
function refreshCompetencyStatuses(db, employeeId) {
  db.prepare(`UPDATE employee_competencies SET status = 'expired' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date < DATE('now') AND status != 'suspended'`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'expiring_soon' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date >= DATE('now') AND expiry_date <= DATE('now', '+30 days') AND status NOT IN ('expired','suspended','missing')`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'valid' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date > DATE('now', '+30 days') AND status NOT IN ('suspended','missing')`).run(employeeId);
}

// ============================================
// HR DASHBOARD
// ============================================
router.get('/', requirePermission('hr_dashboard'), (req, res) => {
  const db = getDb();
  const { company, division, region, employment_type, manager_id } = req.query;

  let baseWhere = '1=1';
  const params = [];
  if (company) { baseWhere += ' AND e.company = ?'; params.push(company); }
  if (division) { baseWhere += ' AND e.division = ?'; params.push(division); }
  if (region) { baseWhere += ' AND e.primary_work_region = ?'; params.push(region); }
  if (employment_type) { baseWhere += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (manager_id) { baseWhere += ' AND e.manager_id = ?'; params.push(manager_id); }

  // Headcount stats
  const total = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.active = 1`).get(...params).c;
  const active = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'active'`).get(...params).c;
  const casual = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_type = 'casual' AND e.active = 1`).get(...params).c;
  const subcontractor = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_type = 'subcontractor' AND e.active = 1`).get(...params).c;
  const onLeave = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'on_leave'`).get(...params).c;
  const onboarding = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'onboarding'`).get(...params).c;

  // Compliance stats
  const expiring7 = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')`).get(...params).c;
  const expiring30 = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')`).get(...params).c;
  const expired = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date < DATE('now') AND e.active = 1`).get(...params).c;
  const blocked = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.blocked_from_allocation = 1 AND e.active = 1`).get(...params).c;
  const pendingVerification = db.prepare(`SELECT COUNT(*) as c FROM employee_documents ed JOIN employees e ON ed.employee_id = e.id WHERE ${baseWhere} AND ed.verification_status = 'pending'`).get(...params).c;

  // Recent employees
  const recentEmployees = db.prepare(`SELECT e.*, m.full_name as manager_name FROM employees e LEFT JOIN employees m ON e.manager_id = m.id WHERE ${baseWhere.replace(/e\./g, 'e.')} AND e.active = 1 ORDER BY e.created_at DESC LIMIT 10`).all(...params);

  // Expiring competencies (next 30 days) for licence/expiry section
  const expiringCompetencies = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code, e.id as employee_id
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC LIMIT 15
  `).all();

  // Blocked workers
  const blockedWorkers = db.prepare(`
    SELECT id, full_name, employee_code, company, block_reason
    FROM employees WHERE blocked_from_allocation = 1 AND active = 1
    ORDER BY full_name
  `).all();

  // Missing mandatory documents
  const missingDocs = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.company,
      COUNT(CASE WHEN ed.verification_status != 'verified' THEN 1 END) as unverified_count
    FROM employees e
    LEFT JOIN employee_documents ed ON ed.employee_id = e.id AND ed.mandatory = 1
    WHERE e.active = 1
    GROUP BY e.id
    HAVING unverified_count > 0
    ORDER BY unverified_count DESC LIMIT 10
  `).all();

  // Employment type breakdown for reports section
  const employmentTypes = db.prepare(`
    SELECT employment_type, COUNT(*) as count
    FROM employees WHERE active = 1
    GROUP BY employment_type ORDER BY count DESC
  `).all();

  // Headcount by division for bar chart
  const headcountByDivision = db.prepare(`
    SELECT division, COUNT(*) as count
    FROM employees WHERE active = 1 AND division != ''
    GROUP BY division ORDER BY count DESC
  `).all();

  // Filter options (map to plain string arrays for view templates)
  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const divisions = db.prepare("SELECT DISTINCT division FROM employees WHERE division != '' ORDER BY division").all().map(r => r.division);
  const regions = db.prepare("SELECT DISTINCT primary_work_region FROM employees WHERE primary_work_region != '' ORDER BY primary_work_region").all().map(r => r.primary_work_region);
  const managers = db.prepare('SELECT id, full_name FROM employees WHERE id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY full_name').all();

  res.render('hr/dashboard', {
    title: 'HR Dashboard',
    currentPage: 'hr-dashboard',
    stats: { total, active, casual, subcontractor, onLeave, onboarding, expiring7, expiring30, expired, blocked, pendingVerification },
    recentEmployees,
    expiringCompetencies,
    blockedWorkers,
    missingDocs,
    employmentTypes,
    headcountByDivision,
    filters: { company, division, region, employment_type, manager_id },
    filterOptions: { companies, divisions, regions, managers },
    user: req.session.user
  });
});

// ============================================
// ROSTER (new employees list — replaces /employees view)
// ============================================
router.get('/roster', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { employment_type, status, level, search, sort, order, payment_type, view } = req.query;
  const showDeleted = view === 'deleted';

  let where = showDeleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status) { where += ' AND e.employment_status = ?'; params.push(status); }
  if (level) { where += ' AND (e.traffic_role_level = ? OR e.role_title = ?)'; params.push(level, level); }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s, s); }

  const sortCol = { full_name: 'e.full_name', employee_code: 'e.employee_code', start_date: 'e.start_date', status: 'e.employment_status', deleted_at: 'e.deleted_at' }[sort] || (showDeleted ? 'e.deleted_at' : 'e.full_name');
  const sortOrder = order === 'desc' ? 'DESC' : (showDeleted && !sort ? 'DESC' : 'ASC');

  const employees = db.prepare(`
    SELECT e.*, m.full_name as manager_name,
      cm.employee_id as worker_id, cm.pin_plain as worker_pin,
      CASE WHEN cm.pin_hash IS NOT NULL THEN 1 ELSE 0 END as has_pin,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry
    FROM employees e
    LEFT JOIN employees m ON e.manager_id = m.id
    LEFT JOIN crew_members cm ON e.linked_crew_member_id = cm.id
    WHERE ${where}
    ORDER BY ${sortCol} ${sortOrder}
  `).all(...params);

  employees.forEach(emp => {
    const comps = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ?').all(emp.id);
    const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id = ?').all(emp.id);
    emp.readiness = computeReadiness(emp, comps, docs);
  });

  // Stats (all exclude deleted except totalDeleted)
  const totalActive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'active' AND deleted_at IS NULL").get().c;
  const totalDeactivated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('inactive', 'deactivated') AND deleted_at IS NULL").get().c;
  const totalOnLeave = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'on_leave' AND deleted_at IS NULL").get().c;
  const totalTerminated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('terminated', 'offboarded') AND deleted_at IS NULL").get().c;
  const totalCash = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'cash' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalTfn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'tfn' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalAbn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'abn' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalActiveAll = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NULL").get().c;
  const totalDeleted = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NOT NULL").get().c;

  res.render('hr/roster', {
    title: 'Roster',
    currentPage: 'hr-roster',
    employees,
    stats: { totalActive, totalDeactivated, totalOnLeave, totalTerminated, totalCash, totalTfn, totalAbn, totalActiveAll, totalDeleted },
    filters: { employment_type, status, level, search, sort, order, payment_type, view },
    showDeleted,
    user: req.session.user
  });
});

// ============================================
// ROSTER BULK SOFT-DELETE (move to Deleted tab)
// ============================================
router.post('/roster/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/roster'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/roster'); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Deactivate linked login users BEFORE soft-deleting the employees
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 0 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Soft-delete employees — preserve all related records for restore
    db.prepare(`UPDATE employees SET deleted_at = CURRENT_TIMESTAMP, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) moved to Deleted.`);
  } catch (err) {
    console.error('Roster bulk soft-delete error:', err);
    req.flash('error', 'Error deleting employees: ' + err.message);
  }
  res.redirect('/hr/roster');
});

// ============================================
// ROSTER BULK RESTORE (from Deleted tab)
// ============================================
router.post('/roster/restore', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/roster?view=deleted'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/roster?view=deleted'); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Reactivate linked login users
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 1 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Restore employees — clear deleted_at, reactivate, set status back to active
    db.prepare(`UPDATE employees SET deleted_at = NULL, active = 1, employment_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) restored.`);
  } catch (err) {
    console.error('Roster bulk restore error:', err);
    req.flash('error', 'Error restoring employees: ' + err.message);
  }
  res.redirect('/hr/roster?view=deleted');
});

// ============================================
// EMPLOYEES LIST (legacy — kept for backward compat)
// ============================================
router.get('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { company, division, employment_type, status, manager_id, search, allocatable, sort, order, payment_type } = req.query;

  let where = '1=1';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (division) { where += ' AND e.division = ?'; params.push(division); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status) { where += ' AND e.employment_status = ?'; params.push(status); }
  if (manager_id) { where += ' AND e.manager_id = ?'; params.push(manager_id); }
  if (allocatable === '1') { where += ' AND e.allocatable = 1 AND e.blocked_from_allocation = 0'; }
  if (allocatable === '0') { where += ' AND (e.allocatable = 0 OR e.blocked_from_allocation = 1)'; }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s, s); }

  const sortCol = { full_name: 'e.full_name', employee_code: 'e.employee_code', company: 'e.company', start_date: 'e.start_date', status: 'e.employment_status' }[sort] || 'e.full_name';
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  const employees = db.prepare(`
    SELECT e.*, m.full_name as manager_name,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry
    FROM employees e
    LEFT JOIN employees m ON e.manager_id = m.id
    WHERE ${where}
    ORDER BY ${sortCol} ${sortOrder}
  `).all(...params);

  // Compute readiness for each
  employees.forEach(emp => {
    const comps = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ?').all(emp.id);
    const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id = ?').all(emp.id);
    emp.readiness = computeReadiness(emp, comps, docs);
  });

  // Stats
  const totalActive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE active = 1").get().c;
  const totalOnboarding = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'onboarding'").get().c;
  const totalBlocked = db.prepare("SELECT COUNT(*) as c FROM employees WHERE blocked_from_allocation = 1 AND active = 1").get().c;
  const totalCash = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'cash' AND active = 1").get().c;
  const totalTfn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'tfn' AND active = 1").get().c;
  const totalAbn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'abn' AND active = 1").get().c;

  // Filter options (map to plain string arrays for view templates)
  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const divisions = db.prepare("SELECT DISTINCT division FROM employees WHERE division != '' ORDER BY division").all().map(r => r.division);
  const managers = db.prepare('SELECT id, full_name FROM employees WHERE id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY full_name').all();

  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employees', {
    title: 'Employees',
    currentPage: 'hr-employees',
    employees,
    stats: { totalActive, totalOnboarding, totalBlocked, totalCash, totalTfn, totalAbn },
    filters: { company, division, employment_type, status, manager_id, search, allocatable, sort, order, payment_type },
    filterOptions: { companies, divisions, managers },
    settingsOptions,
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// ADD EMPLOYEE FORM
// ============================================
router.get('/employees/new', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const allEmployees = db.prepare('SELECT id, full_name FROM employees WHERE active = 1 ORDER BY full_name').all();
  const crewMembers = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const users = db.prepare('SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY full_name').all();
  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employee-form', {
    title: 'New Employee',
    currentPage: 'hr-employees',
    employee: null,
    allEmployees,
    crewMembers,
    users,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// CREATE EMPLOYEE
// ============================================
router.post('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = req.body;

  const fullName = [(b.first_name || '').trim(), (b.middle_name || '').trim(), (b.last_name || '').trim()].filter(Boolean).join(' ');

  // Only save rates if user has permission
  const rateFields = canViewRates(req.session.user) ? {
    rate_day: parseFloat(b.rate_day) || 0, rate_ot: parseFloat(b.rate_ot) || 0, rate_dt: parseFloat(b.rate_dt) || 0,
    rate_night: parseFloat(b.rate_night) || 0, rate_night_ot: parseFloat(b.rate_night_ot) || 0, rate_night_dt: parseFloat(b.rate_night_dt) || 0,
    rate_travel: parseFloat(b.rate_travel) || 0, rate_meal: parseFloat(b.rate_meal) || 0, rate_weekend: parseFloat(b.rate_weekend) || 0,
  } : {};

  const result = db.prepare(`
    INSERT INTO employees (employee_code, first_name, middle_name, last_name, full_name, preferred_name, company, division, role_title,
      employment_type, employment_status, payment_type, start_date, end_date, probation_end_date, manager_id,
      email, phone, address, suburb, state, postcode,
      traffic_role_level, ticket_classification, white_card_required, medical_required,
      allocatable, blocked_from_allocation, block_reason, induction_status,
      ppe_issued_status, uniform_issued_status, company_vehicle_assigned,
      primary_work_region, base_location,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      date_of_birth, payroll_reference, internal_notes, active,
      linked_crew_member_id, linked_user_id,
      rate_day, rate_ot, rate_dt, rate_night, rate_night_ot, rate_night_dt, rate_travel, rate_meal, rate_weekend)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.employee_code || null, b.first_name, b.middle_name || '', b.last_name, fullName, b.preferred_name || '',
    b.company || '', b.division || '', b.role_title || '',
    b.employment_type || 'full_time', b.employment_status || 'active', b.payment_type || '',
    b.start_date || null, b.end_date || null, b.probation_end_date || null, b.manager_id || null,
    b.email || '', b.phone || '', b.address || '', b.suburb || '', b.state || '', b.postcode || '',
    b.traffic_role_level || '', b.ticket_classification || '',
    b.white_card_required ? 1 : 0, b.medical_required ? 1 : 0,
    b.allocatable ? 1 : 0, b.blocked_from_allocation ? 1 : 0, b.block_reason || '',
    b.induction_status || 'pending',
    b.ppe_issued_status || 'not_issued', b.uniform_issued_status || 'not_issued',
    b.company_vehicle_assigned || '',
    b.primary_work_region || '', b.base_location || '',
    b.emergency_contact_name || '', b.emergency_contact_phone || '', b.emergency_contact_relationship || '',
    b.date_of_birth || null, b.payroll_reference || '', b.internal_notes || '',
    b.linked_crew_member_id || null, b.linked_user_id || null,
    rateFields.rate_day || 0, rateFields.rate_ot || 0, rateFields.rate_dt || 0,
    rateFields.rate_night || 0, rateFields.rate_night_ot || 0, rateFields.rate_night_dt || 0,
    rateFields.rate_travel || 0, rateFields.rate_meal || 0, rateFields.rate_weekend || 0
  );

  req.flash('success', 'Employee created successfully.');
  res.redirect(`/hr/employees/${result.lastInsertRowid}`);
});

// ============================================
// BULK DELETE EMPLOYEES
// ============================================
router.post('/employees/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/employees'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/employees'); }

  const placeholders = ids.map(() => '?').join(',');

  // Delete uploaded document files from disk first (before deleting DB records)
  try {
    const docs = db.prepare(`SELECT file_path FROM employee_documents WHERE employee_id IN (${placeholders})`).all(...ids);
    for (const doc of docs) {
      if (doc.file_path) { try { fs.unlinkSync(doc.file_path); } catch (e) { /* ignore */ } }
    }
  } catch (e) { /* ignore */ }

  // Delete related records from all tables that reference employees
  const relatedTables = ['employee_competencies', 'employee_documents', 'employee_leave'];
  for (const table of relatedTables) {
    try { db.prepare(`DELETE FROM ${table} WHERE employee_id IN (${placeholders})`).run(...ids); } catch (e) { /* table may not exist */ }
  }

  // Null out manager_id self-references so other employees aren't blocked
  try { db.prepare(`UPDATE employees SET manager_id = NULL WHERE manager_id IN (${placeholders})`).run(...ids); } catch (e) { /* ignore */ }

  // Delete uploaded HR folders
  for (const id of ids) {
    const empDir = path.join(UPLOAD_BASE, `emp_${id}`);
    try { fs.rmSync(empDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  try {
    const result = db.prepare(`DELETE FROM employees WHERE id IN (${placeholders})`).run(...ids);
    const count = result.changes;
    req.flash('success', `Deleted ${count} employee${count !== 1 ? 's' : ''}.`);
  } catch (e) {
    console.error('Employee delete error:', e.message);
    req.flash('error', 'Could not delete employee(s): ' + e.message);
  }
  res.redirect('/hr/employees');
});

// ============================================
// EMPLOYEE DETAIL
// ============================================
router.get('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

  const manager = employee.manager_id ? db.prepare('SELECT id, full_name FROM employees WHERE id = ?').get(employee.manager_id) : null;
  const documents = db.prepare('SELECT ed.*, u.full_name as uploaded_by_name, v.full_name as verified_by_name FROM employee_documents ed LEFT JOIN users u ON ed.uploaded_by_id = u.id LEFT JOIN users v ON ed.verified_by_id = v.id WHERE ed.employee_id = ? ORDER BY ed.created_at DESC').all(employee.id);

  refreshCompetencyStatuses(db, employee.id);
  const competencies = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);

  const readiness = computeReadiness(employee, competencies, documents);

  // Linked crew data
  let crewMember = null;
  let upcomingShifts = [];
  let recentTimesheets = [];
  if (employee.linked_crew_member_id) {
    crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(employee.linked_crew_member_id);
    upcomingShifts = db.prepare(`
      SELECT ca.*, j.job_number, j.client FROM crew_allocations ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.crew_member_id = ? AND ca.allocation_date >= DATE('now') AND ca.status != 'cancelled'
      ORDER BY ca.allocation_date ASC LIMIT 10
    `).all(employee.linked_crew_member_id);
    recentTimesheets = db.prepare(`
      SELECT t.*, j.job_number, j.client FROM timesheets t
      JOIN jobs j ON t.job_id = j.id
      WHERE t.crew_member_id = ? ORDER BY t.work_date DESC LIMIT 10
    `).all(employee.linked_crew_member_id);
  }

  const settingsOptions = res.locals.settingsOptions || {};

  // Training completions
  let training = [];
  try { training = db.prepare('SELECT * FROM training_completions WHERE employee_id = ? ORDER BY completed_at DESC').all(employee.id); } catch (e) {}

  res.render('hr/employee-show', {
    title: employee.full_name,
    currentPage: 'hr-employees',
    employee,
    manager,
    documents,
    competencies,
    readiness,
    crewMember,
    upcomingShifts,
    recentTimesheets,
    training,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// EDIT EMPLOYEE FORM
// ============================================
router.get('/employees/:id/edit', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

  const allEmployees = db.prepare('SELECT id, full_name FROM employees WHERE active = 1 AND id != ? ORDER BY full_name').all(employee.id);
  const crewMembers = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const users = db.prepare('SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY full_name').all();
  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employee-form', {
    title: 'Edit Employee: ' + employee.full_name,
    currentPage: 'hr-employees',
    employee,
    allEmployees,
    crewMembers,
    users,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// UPDATE EMPLOYEE
// ============================================
router.post('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const fullName = [(b.first_name || '').trim(), (b.middle_name || '').trim(), (b.last_name || '').trim()].filter(Boolean).join(' ');

  // Build SET pairs and params array dynamically
  const sets = [];
  const params = [];

  function set(col, val) { sets.push(col + ' = ?'); params.push(val); }

  set('employee_code', b.employee_code || null);
  set('first_name', b.first_name || '');
  set('middle_name', b.middle_name || '');
  set('last_name', b.last_name || '');
  set('full_name', fullName);
  set('preferred_name', b.preferred_name || '');
  set('company', b.company || '');
  set('division', b.division || '');
  set('role_title', b.role_title || '');
  set('employment_type', b.employment_type || 'full_time');
  set('employment_status', b.employment_status || 'active');
  set('payment_type', b.payment_type || '');
  set('start_date', b.start_date || null);
  set('end_date', b.end_date || null);
  set('probation_end_date', b.probation_end_date || null);
  set('manager_id', b.manager_id || null);
  set('email', b.email || '');
  set('phone', b.phone || '');
  set('address', b.address || '');
  set('suburb', b.suburb || '');
  set('state', b.state || '');
  set('postcode', b.postcode || '');
  set('traffic_role_level', b.traffic_role_level || '');
  set('ticket_classification', b.ticket_classification || '');
  set('white_card_required', b.white_card_required ? 1 : 0);
  set('medical_required', b.medical_required ? 1 : 0);
  set('allocatable', b.allocatable ? 1 : 0);
  set('blocked_from_allocation', b.blocked_from_allocation ? 1 : 0);
  set('block_reason', b.block_reason || '');
  set('induction_status', b.induction_status || 'pending');
  set('ppe_issued_status', b.ppe_issued_status || 'not_issued');
  set('uniform_issued_status', b.uniform_issued_status || 'not_issued');
  set('company_vehicle_assigned', b.company_vehicle_assigned || '');
  set('primary_work_region', b.primary_work_region || '');
  set('base_location', b.base_location || '');
  set('emergency_contact_name', b.emergency_contact_name || '');
  set('emergency_contact_phone', b.emergency_contact_phone || '');
  set('emergency_contact_relationship', b.emergency_contact_relationship || '');
  set('date_of_birth', b.date_of_birth || null);
  set('payroll_reference', b.payroll_reference || '');
  set('internal_notes', b.internal_notes || '');
  set('linked_crew_member_id', b.linked_crew_member_id || null);
  set('linked_user_id', b.linked_user_id || null);
  set('white_card_number', b.white_card_number || '');
  set('tc_licence_number', b.tc_licence_number || '');
  set('tc_licence_state', b.tc_licence_state || '');
  set('tc_licence_date_of_issue', b.tc_licence_date_of_issue || '');
  set('drivers_licence_number', b.drivers_licence_number || '');

  if (canViewRates(req.session.user)) {
    set('rate_day', parseFloat(b.rate_day) || 0);
    set('rate_ot', parseFloat(b.rate_ot) || 0);
    set('rate_dt', parseFloat(b.rate_dt) || 0);
    set('rate_night', parseFloat(b.rate_night) || 0);
    set('rate_night_ot', parseFloat(b.rate_night_ot) || 0);
    set('rate_night_dt', parseFloat(b.rate_night_dt) || 0);
    set('rate_travel', parseFloat(b.rate_travel) || 0);
    set('rate_meal', parseFloat(b.rate_meal) || 0);
    set('rate_weekend', parseFloat(b.rate_weekend) || 0);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  try {
    db.prepare('UPDATE employees SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);
    req.flash('success', 'Employee updated successfully.');
  } catch (err) {
    console.error('UPDATE employee error:', err.message, { id: req.params.id, setCount: sets.length, paramCount: params.length });
    req.flash('error', 'Error updating employee: ' + err.message);
  }
  res.redirect(`/hr/employees/${req.params.id}`);
});

// ============================================
// WORKER PORTAL PIN MANAGEMENT
// ============================================

// Helper: load employee + linked crew member, or flash error
function loadEmployeeWithCrew(req, res) {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return null; }
  if (!employee.linked_crew_member_id) { req.flash('error', 'Employee is not linked to a crew member.'); return null; }
  const crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(employee.linked_crew_member_id);
  if (!crewMember) { req.flash('error', 'Linked crew member not found.'); return null; }
  return { employee, crewMember };
}

// POST /employees/:id/set-pin — Set or reset worker portal PIN
router.post('/employees/:id/set-pin', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res);
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  const { pin } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
  }

  const pinHash = bcrypt.hashSync(pin, 12);
  getDb().prepare('UPDATE crew_members SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP, pin_set_by_id = ? WHERE id = ?')
    .run(pinHash, pin, req.session.user.id, crewMember.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Set worker portal PIN (from HR)', ip: req.ip });
  req.flash('success', 'Portal PIN set for ' + crewMember.full_name);
  res.redirect(`/hr/employees/${employee.id}#workforce`);
});

// POST /employees/:id/clear-pin — Remove worker portal PIN
router.post('/employees/:id/clear-pin', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res);
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  getDb().prepare('UPDATE crew_members SET pin_hash = NULL, pin_plain = NULL, pin_set_at = NULL, pin_set_by_id = NULL WHERE id = ?')
    .run(crewMember.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Cleared worker portal PIN (from HR)', ip: req.ip });
  req.flash('success', 'Portal PIN cleared for ' + crewMember.full_name);
  res.redirect(`/hr/employees/${employee.id}#workforce`);
});

// POST /employees/:id/send-invite — Send email invitation for worker portal
router.post('/employees/:id/send-invite', requirePermission('hr_employees'), async (req, res) => {
  const data = loadEmployeeWithCrew(req, res);
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  if (!crewMember.email || !crewMember.employee_id) {
    req.flash('error', 'Crew member needs both an email and Employee ID to receive an invite.');
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
  }

  try {
    const { token } = createInvitation({ type: 'crew_member', targetId: crewMember.id, email: crewMember.email, createdById: req.session.user.id });
    const setupUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/w/setup/' + token;
    await sendEmail(crewMember.email, 'Set up your T&S Worker Portal PIN', workerInviteEmail(crewMember.full_name, setupUrl, TOKEN_EXPIRY_HOURS));

    logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Sent worker portal email invitation (from HR)', ip: req.ip });
    req.flash('success', `Invitation email sent to ${crewMember.email}`);
  } catch (err) {
    console.error('Send invite error:', err);
    req.flash('error', 'Failed to send invitation email.');
  }
  res.redirect(`/hr/employees/${employee.id}#workforce`);
});

// ============================================
// DOCUMENT UPLOAD
// ============================================
router.post('/employees/:id/documents/upload', requirePermission('hr_documents'), upload.single('file'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee || !req.file) { req.flash('error', 'Upload failed.'); return res.redirect('back'); }

  const b = req.body;
  db.prepare(`
    INSERT INTO employee_documents (employee_id, document_type, document_name, filename, original_name, file_path, file_size,
      issue_date, expiry_date, mandatory, notes, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employee.id, b.document_type || 'other', b.document_name || req.file.originalname,
    req.file.filename, req.file.originalname, req.file.path, req.file.size,
    b.issue_date || null, b.expiry_date || null, b.mandatory ? 1 : 0,
    b.notes || '', req.session.user.id
  );

  req.flash('success', 'Document uploaded.');
  res.redirect(`/hr/employees/${employee.id}#documents`);
});

// ============================================
// DOCUMENT VERIFY / REJECT
// ============================================
router.post('/documents/:id/verify', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  const action = req.body.action; // 'verify' or 'reject'
  const newStatus = action === 'reject' ? 'rejected' : 'verified';

  db.prepare('UPDATE employee_documents SET verification_status = ?, verified_by_id = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, req.session.user.id, doc.id);

  req.flash('success', `Document ${newStatus}.`);
  res.redirect(`/hr/employees/${doc.employee_id}#documents`);
});

// ============================================
// DOCUMENT DOWNLOAD
// ============================================
router.get('/documents/:id/download', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  if (!fs.existsSync(doc.file_path)) {
    req.flash('error', 'File not found on disk.');
    return res.redirect('back');
  }

  // If ?inline=1 or the request is for an image, serve inline for preview
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif)$/i.test(doc.original_name || doc.filename);
  if (req.query.inline || isImage) {
    const ext = path.extname(doc.original_name || doc.filename).toLowerCase();
    const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_name || doc.filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.resolve(doc.file_path));
  }

  res.download(doc.file_path, doc.original_name);
});

// ============================================
// DOCUMENT DELETE
// ============================================
router.post('/documents/:id/delete', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  // Delete file from disk
  try { if (fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path); } catch (e) { /* ignore */ }

  db.prepare('DELETE FROM employee_documents WHERE id = ?').run(doc.id);
  req.flash('success', 'Document deleted.');
  res.redirect(`/hr/employees/${doc.employee_id}#documents`);
});

// ============================================
// DOCUMENTS LIST (central view)
// ============================================
router.get('/documents', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const { document_type, verification_status, expiry, employee_id, company, mandatory } = req.query;

  let where = '1=1';
  const params = [];
  if (document_type) { where += ' AND ed.document_type = ?'; params.push(document_type); }
  if (verification_status) { where += ' AND ed.verification_status = ?'; params.push(verification_status); }
  if (employee_id) { where += ' AND ed.employee_id = ?'; params.push(employee_id); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (mandatory === '1') { where += ' AND ed.mandatory = 1'; }
  if (expiry === 'expired') { where += " AND ed.expiry_date < DATE('now')"; }
  if (expiry === '7days') { where += " AND ed.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')"; }
  if (expiry === '30days') { where += " AND ed.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')"; }

  const documents = db.prepare(`
    SELECT ed.*, e.full_name as employee_name, e.employee_code, e.company as employee_company,
      u.full_name as uploaded_by_name, v.full_name as verified_by_name
    FROM employee_documents ed
    JOIN employees e ON ed.employee_id = e.id
    LEFT JOIN users u ON ed.uploaded_by_id = u.id
    LEFT JOIN users v ON ed.verified_by_id = v.id
    WHERE ${where}
    ORDER BY ed.created_at DESC
  `).all(...params);

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/documents', {
    title: 'HR Documents',
    currentPage: 'hr-documents',
    documents,
    filters: { document_type, verification_status, expiry, employee_id, company, mandatory },
    filterOptions: { companies },
    settingsOptions,
    user: req.session.user
  });
});

// ============================================
// COMPETENCIES LIST
// ============================================
router.get('/competencies', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const { competency_type, status, company, mandatory, view } = req.query;

  // Refresh all statuses first
  db.prepare(`UPDATE employee_competencies SET status = 'expired' WHERE expiry_date IS NOT NULL AND expiry_date < DATE('now') AND status NOT IN ('suspended','missing')`).run();
  db.prepare(`UPDATE employee_competencies SET status = 'expiring_soon' WHERE expiry_date IS NOT NULL AND expiry_date >= DATE('now') AND expiry_date <= DATE('now', '+30 days') AND status NOT IN ('expired','suspended','missing')`).run();

  let where = '1=1';
  const params = [];
  if (competency_type) { where += ' AND ec.competency_type = ?'; params.push(competency_type); }
  if (status) { where += ' AND ec.status = ?'; params.push(status); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (mandatory === '1') { where += ' AND ec.mandatory_for_role = 1'; }
  if (view === '7days') { where += " AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')"; }
  if (view === '30days') { where += " AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')"; }
  if (view === 'expired') { where += " AND ec.expiry_date < DATE('now')"; }
  if (view === 'missing') { where += " AND ec.status = 'missing'"; }

  const competencies = db.prepare(`
    SELECT ec.*, e.full_name as employee_name, e.employee_code, e.company as employee_company,
      ed.original_name as linked_doc_name
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    LEFT JOIN employee_documents ed ON ec.linked_document_id = ed.id
    WHERE ${where} AND e.active = 1
    ORDER BY ec.expiry_date ASC NULLS LAST
  `).all(...params);

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const settingsOptions = res.locals.settingsOptions || {};

  // Stats
  const totalExpired = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'expired' AND e.active = 1").get().c;
  const totalExpiring = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'expiring_soon' AND e.active = 1").get().c;
  const totalMissing = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'missing' AND e.active = 1").get().c;

  res.render('hr/competencies', {
    title: 'Licences & Competencies',
    currentPage: 'hr-competencies',
    competencies,
    stats: { totalExpired, totalExpiring, totalMissing },
    filters: { competency_type, status, company, mandatory, view },
    filterOptions: { companies },
    settingsOptions,
    user: req.session.user
  });
});

// ============================================
// ADD COMPETENCY
// ============================================
router.post('/employees/:id/competencies', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('back'); }

  db.prepare(`
    INSERT INTO employee_competencies (employee_id, competency_type, competency_name, competency_level,
      issue_date, expiry_date, status, mandatory_for_role, linked_document_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employee.id, b.competency_type || 'other', b.competency_name || '',
    b.competency_level || '', b.issue_date || null, b.expiry_date || null,
    b.status || 'valid', b.mandatory_for_role ? 1 : 0,
    b.linked_document_id || null, b.notes || ''
  );

  refreshCompetencyStatuses(db, employee.id);
  req.flash('success', 'Competency added.');
  res.redirect(`/hr/employees/${employee.id}#competencies`);
});

// ============================================
// UPDATE COMPETENCY
// ============================================
router.post('/competencies/:id', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return res.redirect('back'); }

  db.prepare(`
    UPDATE employee_competencies SET competency_type = ?, competency_name = ?, competency_level = ?,
      issue_date = ?, expiry_date = ?, status = ?, mandatory_for_role = ?,
      linked_document_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    b.competency_type || 'other', b.competency_name || '', b.competency_level || '',
    b.issue_date || null, b.expiry_date || null, b.status || 'valid',
    b.mandatory_for_role ? 1 : 0, b.linked_document_id || null, b.notes || '',
    comp.id
  );

  refreshCompetencyStatuses(db, comp.employee_id);
  req.flash('success', 'Competency updated.');
  res.redirect(`/hr/employees/${comp.employee_id}#competencies`);
});

// ============================================
// DELETE COMPETENCY
// ============================================
router.post('/competencies/:id/delete', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return res.redirect('back'); }

  db.prepare('DELETE FROM employee_competencies WHERE id = ?').run(comp.id);
  req.flash('success', 'Competency removed.');
  res.redirect(`/hr/employees/${comp.employee_id}#competencies`);
});

// ============================================
// HR REPORTS
// ============================================
router.get('/reports', requirePermission('hr_reports'), (req, res) => {
  const db = getDb();

  // Headcount by company
  const headcountByCompany = db.prepare(`
    SELECT company, COUNT(*) as count, employment_type
    FROM employees WHERE active = 1 AND company != ''
    GROUP BY company, employment_type ORDER BY company
  `).all();

  // Headcount by division
  const headcountByDivision = db.prepare(`
    SELECT division, COUNT(*) as count
    FROM employees WHERE active = 1 AND division != ''
    GROUP BY division ORDER BY count DESC
  `).all();

  // Employment type breakdown
  const employmentTypes = db.prepare(`
    SELECT employment_type, COUNT(*) as count
    FROM employees WHERE active = 1
    GROUP BY employment_type ORDER BY count DESC
  `).all();

  // Expiring competencies
  const expiringCompetencies = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC
  `).all();

  // Missing mandatory documents
  const missingDocs = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.company,
      COUNT(CASE WHEN ed.verification_status != 'verified' THEN 1 END) as unverified_count
    FROM employees e
    LEFT JOIN employee_documents ed ON ed.employee_id = e.id AND ed.mandatory = 1
    WHERE e.active = 1
    GROUP BY e.id
    HAVING unverified_count > 0
    ORDER BY unverified_count DESC
  `).all();

  // Blocked workers
  const blockedWorkers = db.prepare(`
    SELECT id, full_name, employee_code, company, block_reason
    FROM employees WHERE blocked_from_allocation = 1 AND active = 1
    ORDER BY full_name
  `).all();

  // Headcount by employment status
  const headcountByStatus = db.prepare(`
    SELECT employment_status, COUNT(*) as count
    FROM employees
    GROUP BY employment_status
    ORDER BY count DESC
  `).all();

  // Expiring competencies in next 90 days (for timeline chart)
  const expiringCompetencies90 = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code,
      CAST(julianday(ec.expiry_date) - julianday('now') AS INTEGER) as days_left
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+90 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC
  `).all();

  // Compliance rate calculation
  const totalActive = db.prepare("SELECT COUNT(*) as count FROM employees WHERE active = 1").get().count;
  const blockedCount = blockedWorkers.length;
  const complianceRate = totalActive > 0 ? Math.round(((totalActive - blockedCount) / totalActive) * 100) : 100;

  res.render('hr/reports', {
    title: 'HR Reports',
    currentPage: 'hr-reports',
    headcountByCompany,
    headcountByDivision,
    employmentTypes,
    expiringCompetencies,
    missingDocs,
    blockedWorkers,
    headcountByStatus,
    expiringCompetencies90,
    complianceRate,
    totalActive,
    blockedCount,
    user: req.session.user
  });
});

// ============================================
// COMPLIANCE VIEW (for ops/planning — read-only)
// ============================================
router.get('/compliance', requirePermission('hr_compliance_view'), (req, res) => {
  const db = getDb();
  const { company, search } = req.query;

  let where = "e.active = 1";
  const params = [];
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ?)'; const s = `%${search}%`; params.push(s, s); }

  const employees = db.prepare(`
    SELECT e.id, e.employee_code, e.full_name, e.company, e.division, e.role_title,
      e.employment_status, e.allocatable, e.blocked_from_allocation, e.block_reason,
      e.induction_status,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry,
      (SELECT COUNT(*) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.status = 'expired') as expired_count,
      (SELECT COUNT(*) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.status = 'expiring_soon') as expiring_count
    FROM employees e
    WHERE ${where}
    ORDER BY e.full_name
  `).all(...params);

  employees.forEach(emp => {
    if (emp.blocked_from_allocation) emp.readiness = { status: 'blocked', color: 'red' };
    else if (emp.employment_status === 'on_leave') emp.readiness = { status: 'on_leave', color: 'blue' };
    else if (emp.expired_count > 0) emp.readiness = { status: 'non_compliant', color: 'red' };
    else if (emp.expiring_count > 0) emp.readiness = { status: 'ready_with_warnings', color: 'amber' };
    else emp.readiness = { status: 'ready', color: 'green' };
  });

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' AND active = 1 ORDER BY company").all().map(r => r.company);

  res.render('hr/compliance-view', {
    title: 'Workforce Compliance',
    currentPage: 'hr-compliance',
    employees,
    filters: { company, search },
    filterOptions: { companies },
    user: req.session.user
  });
});

// ============================================
// DEACTIVATE / REACTIVATE EMPLOYEE
// ============================================
router.post('/employees/:id/toggle-active', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, employment_status, active FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

  const action = req.body.action; // 'deactivate' or 'reactivate'
  if (action === 'deactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('inactive', employee.id);
    req.flash('success', 'Employee deactivated.');
  } else if (action === 'reactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('active', employee.id);
    req.flash('success', 'Employee reactivated.');
  }
  res.redirect(`/hr/employees/${employee.id}`);
});

// ============================================
// BLOCK / UNBLOCK EMPLOYEE
// ============================================
router.post('/employees/:id/block', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const action = req.body.action; // 'block' or 'unblock'
  if (action === 'unblock') {
    db.prepare('UPDATE employees SET blocked_from_allocation = 0, block_reason = "", updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    req.flash('success', 'Employee unblocked from allocation.');
  } else {
    db.prepare('UPDATE employees SET blocked_from_allocation = 1, block_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.block_reason || '', req.params.id);
    req.flash('success', 'Employee blocked from allocation.');
  }
  res.redirect(`/hr/employees/${req.params.id}`);
});

module.exports = router;
