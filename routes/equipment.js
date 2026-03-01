const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// EQUIPMENT LIST
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.category) { where.push('e.category = ?'); params.push(req.query.category); }
  if (req.query.condition) { where.push('e.current_condition = ?'); params.push(req.query.condition); }
  if (req.query.search) { where.push("(e.name LIKE ? OR e.asset_number LIKE ? OR e.serial_number LIKE ?)"); const s = `%${req.query.search}%`; params.push(s, s, s); }
  if (req.query.active === '0') {
    // Show all including inactive
  } else {
    where.push('e.active = 1'); // default show active only
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const equipment = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM equipment_assignments ea WHERE ea.equipment_id = e.id AND ea.actual_return_date IS NULL) as currently_deployed,
      (SELECT j.job_number FROM equipment_assignments ea2 JOIN jobs j ON ea2.job_id = j.id WHERE ea2.equipment_id = e.id AND ea2.actual_return_date IS NULL ORDER BY ea2.assigned_date DESC LIMIT 1) as deployed_to_job
    FROM equipment e
    ${whereClause}
    ORDER BY e.category, e.name
  `).all(...params);

  const today = new Date().toISOString().split('T')[0];
  const inspectionsDue = db.prepare("SELECT COUNT(*) as count FROM equipment WHERE active = 1 AND next_inspection_date <= ?").get(today).count;
  const totalDeployed = db.prepare("SELECT COUNT(DISTINCT equipment_id) as count FROM equipment_assignments WHERE actual_return_date IS NULL").get().count;

  res.render('equipment/index', {
    title: 'Equipment Register',
    currentPage: 'equipment',
    equipment,
    filters: req.query,
    stats: { total: equipment.length, inspectionsDue, totalDeployed }
  });
});

// NEW EQUIPMENT FORM
router.get('/new', (req, res) => {
  res.render('equipment/form', { title: 'Add Equipment', currentPage: 'equipment', item: null });
});

// CREATE EQUIPMENT
router.post('/', (req, res) => {
  const db = getDb();
  const { asset_number, name, category, description, serial_number, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, notes } = req.body;

  const result = db.prepare(`
    INSERT INTO equipment (asset_number, name, category, description, serial_number, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(asset_number, name, category, description || '', serial_number || '', purchase_date || null, parseFloat(purchase_cost) || 0, current_condition || 'good', storage_location || '', next_inspection_date || null, parseInt(inspection_interval_days) || 90, notes || '');

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment', entityId: result.lastInsertRowid, entityLabel: `${asset_number} - ${name}`, ip: req.ip });
  req.flash('success', `Equipment ${asset_number} added.`);
  res.redirect('/equipment');
});

// SHOW EQUIPMENT DETAIL
router.get('/:id', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Equipment not found.'); return res.redirect('/equipment'); }

  const assignments = db.prepare(`
    SELECT ea.*, j.job_number, j.client, u.full_name as assigned_by_name
    FROM equipment_assignments ea
    JOIN jobs j ON ea.job_id = j.id
    JOIN users u ON ea.assigned_by_id = u.id
    WHERE ea.equipment_id = ?
    ORDER BY ea.assigned_date DESC
  `).all(req.params.id);

  const maintenance = db.prepare(`
    SELECT * FROM equipment_maintenance WHERE equipment_id = ? ORDER BY performed_date DESC
  `).all(req.params.id);

  const jobs = db.prepare("SELECT id, job_number, client FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('equipment/show', {
    title: `Equipment - ${item.asset_number}`,
    currentPage: 'equipment',
    item,
    assignments,
    maintenance,
    jobs
  });
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Equipment not found.'); return res.redirect('/equipment'); }
  res.render('equipment/form', { title: `Edit ${item.asset_number}`, currentPage: 'equipment', item });
});

// UPDATE EQUIPMENT
router.post('/:id', (req, res) => {
  const db = getDb();
  const { asset_number, name, category, description, serial_number, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, notes, active } = req.body;

  db.prepare(`
    UPDATE equipment SET asset_number=?, name=?, category=?, description=?, serial_number=?, purchase_date=?, purchase_cost=?, current_condition=?, storage_location=?, next_inspection_date=?, inspection_interval_days=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(asset_number, name, category, description || '', serial_number || '', purchase_date || null, parseFloat(purchase_cost) || 0, current_condition, storage_location || '', next_inspection_date || null, parseInt(inspection_interval_days) || 90, notes || '', active !== undefined ? (active ? 1 : 0) : 1, req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'equipment', entityId: parseInt(req.params.id), entityLabel: `${asset_number} - ${name}`, ip: req.ip });
  req.flash('success', 'Equipment updated.');
  res.redirect(`/equipment/${req.params.id}`);
});

// ASSIGN TO JOB
router.post('/:id/assign', (req, res) => {
  const db = getDb();
  const { job_id, assigned_date, expected_return_date, quantity, notes } = req.body;
  const item = db.prepare('SELECT asset_number, name FROM equipment WHERE id = ?').get(req.params.id);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  db.prepare(`
    INSERT INTO equipment_assignments (equipment_id, job_id, assigned_date, expected_return_date, quantity, assigned_by_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, job_id, assigned_date, expected_return_date || null, parseInt(quantity) || 1, req.session.user.id, notes || '');

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_assignment', entityLabel: `${item ? item.asset_number : ''} -> ${job ? job.job_number : ''}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', 'Equipment assigned to job.');
  res.redirect(`/equipment/${req.params.id}`);
});

// RETURN EQUIPMENT
router.post('/:id/assignments/:assignId/return', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE equipment_assignments SET actual_return_date = ? WHERE id = ?').run(today, req.params.assignId);
  logActivity({ user: req.session.user, action: 'update', entityType: 'equipment_assignment', entityId: parseInt(req.params.assignId), details: 'Returned', ip: req.ip });
  req.flash('success', 'Equipment returned.');
  res.redirect(`/equipment/${req.params.id}`);
});

// LOG MAINTENANCE
router.post('/:id/maintenance', (req, res) => {
  const db = getDb();
  const { maintenance_type, description, performed_date, performed_by, cost, next_due_date, result, notes } = req.body;

  db.prepare(`
    INSERT INTO equipment_maintenance (equipment_id, maintenance_type, description, performed_date, performed_by, cost, next_due_date, result, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, maintenance_type, description, performed_date, performed_by || '', parseFloat(cost) || 0, next_due_date || null, result || 'pass', notes || '');

  // Update next inspection date on equipment
  if (next_due_date) {
    db.prepare('UPDATE equipment SET next_inspection_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next_due_date, req.params.id);
  }

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_maintenance', details: `${maintenance_type}: ${description.substring(0, 40)}`, ip: req.ip });
  req.flash('success', 'Maintenance record added.');
  res.redirect(`/equipment/${req.params.id}`);
});

module.exports = router;
