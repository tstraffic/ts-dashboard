const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requirePermission, canViewSensitiveHR } = require('../middleware/auth');

// --- Multer config for HR document uploads ---
const UPLOAD_BASE = path.join(__dirname, '..', 'uploads', 'hr');

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

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

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
    filters: { company, division, region, employment_type, manager_id },
    filterOptions: { companies, divisions, regions, managers },
    user: req.session.user
  });
});

// ============================================
// EMPLOYEES LIST
// ============================================
router.get('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { company, division, employment_type, status, manager_id, search, allocatable, sort, order } = req.query;

  let where = '1=1';
  const params = [];
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

  // Filter options (map to plain string arrays for view templates)
  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const divisions = db.prepare("SELECT DISTINCT division FROM employees WHERE division != '' ORDER BY division").all().map(r => r.division);
  const managers = db.prepare('SELECT id, full_name FROM employees WHERE id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY full_name').all();

  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employees', {
    title: 'Employees',
    currentPage: 'hr-employees',
    employees,
    stats: { totalActive, totalOnboarding, totalBlocked },
    filters: { company, division, employment_type, status, manager_id, search, allocatable, sort, order },
    filterOptions: { companies, divisions, managers },
    settingsOptions,
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
    user: req.session.user
  });
});

// ============================================
// CREATE EMPLOYEE
// ============================================
router.post('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = req.body;

  const fullName = `${(b.first_name || '').trim()} ${(b.last_name || '').trim()}`.trim();

  const result = db.prepare(`
    INSERT INTO employees (employee_code, first_name, last_name, full_name, preferred_name, company, division, role_title,
      employment_type, employment_status, start_date, end_date, probation_end_date, manager_id,
      email, phone, address, suburb, state, postcode,
      traffic_role_level, ticket_classification, white_card_required, medical_required,
      allocatable, blocked_from_allocation, block_reason, induction_status,
      ppe_issued_status, uniform_issued_status, company_vehicle_assigned,
      primary_work_region, base_location,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      date_of_birth, payroll_reference, internal_notes, active,
      linked_crew_member_id, linked_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    b.employee_code || null, b.first_name, b.last_name, fullName, b.preferred_name || '',
    b.company || '', b.division || '', b.role_title || '',
    b.employment_type || 'full_time', b.employment_status || 'active',
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
    b.linked_crew_member_id || null, b.linked_user_id || null
  );

  req.flash('success', 'Employee created successfully.');
  res.redirect(`/hr/employees/${result.lastInsertRowid}`);
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
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
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
    user: req.session.user
  });
});

// ============================================
// UPDATE EMPLOYEE
// ============================================
router.post('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const fullName = `${(b.first_name || '').trim()} ${(b.last_name || '').trim()}`.trim();

  db.prepare(`
    UPDATE employees SET
      employee_code = ?, first_name = ?, last_name = ?, full_name = ?, preferred_name = ?,
      company = ?, division = ?, role_title = ?,
      employment_type = ?, employment_status = ?,
      start_date = ?, end_date = ?, probation_end_date = ?, manager_id = ?,
      email = ?, phone = ?, address = ?, suburb = ?, state = ?, postcode = ?,
      traffic_role_level = ?, ticket_classification = ?,
      white_card_required = ?, medical_required = ?,
      allocatable = ?, blocked_from_allocation = ?, block_reason = ?,
      induction_status = ?,
      ppe_issued_status = ?, uniform_issued_status = ?, company_vehicle_assigned = ?,
      primary_work_region = ?, base_location = ?,
      emergency_contact_name = ?, emergency_contact_phone = ?, emergency_contact_relationship = ?,
      date_of_birth = ?, payroll_reference = ?, internal_notes = ?,
      linked_crew_member_id = ?, linked_user_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    b.employee_code || null, b.first_name, b.last_name, fullName, b.preferred_name || '',
    b.company || '', b.division || '', b.role_title || '',
    b.employment_type || 'full_time', b.employment_status || 'active',
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
    req.params.id
  );

  req.flash('success', 'Employee updated successfully.');
  res.redirect(`/hr/employees/${req.params.id}`);
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

  res.render('hr/reports', {
    title: 'HR Reports',
    currentPage: 'hr-reports',
    headcountByCompany,
    headcountByDivision,
    employmentTypes,
    expiringCompetencies,
    missingDocs,
    blockedWorkers,
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
