const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

const ROADWORTHY_KEYS = ['tyres', 'lights', 'indicators', 'plate', 'chains', 'coupling'];
const FUEL_LEVELS = ['empty', '1_4', '1_2', '3_4', 'full', 'na'];
const STATUSES = ['open', 'picked_up', 'returned', 'closed'];

function nextDocketNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `HD-${year}-`;
  const row = db.prepare(
    "SELECT docket_number FROM hire_dockets WHERE docket_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(prefix + '%');
  let n = 1;
  if (row && row.docket_number) {
    const m = row.docket_number.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function roadworthyCsv(body, prefix) {
  return ROADWORTHY_KEYS.filter(k => body[`${prefix}_roadworthy_${k}`]).join(',');
}

// LIST
router.get('/', (req, res) => {
  const db = getDb();
  const where = [];
  const params = [];
  if (req.query.status && STATUSES.includes(req.query.status)) {
    where.push('hd.status = ?');
    params.push(req.query.status);
  }
  if (req.query.search) {
    where.push("(hd.docket_number LIKE ? OR hd.job_number LIKE ? OR hd.supplier_name LIKE ? OR hd.site_location LIKE ?)");
    const s = `%${req.query.search}%`;
    params.push(s, s, s, s);
  }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const dockets = db.prepare(`
    SELECT hd.*, j.job_number as linked_job_number,
      (SELECT COUNT(*) FROM hire_docket_items hdi WHERE hdi.docket_id = hd.id) as item_count
    FROM hire_dockets hd
    LEFT JOIN jobs j ON hd.job_id = j.id
    ${whereClause}
    ORDER BY hd.created_at DESC
  `).all(...params);

  const counts = db.prepare(`
    SELECT status, COUNT(*) as c FROM hire_dockets GROUP BY status
  `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});

  res.render('equipment/hire-dockets/index', {
    title: 'Hire Dockets',
    currentPage: 'equipment',
    dockets,
    filters: req.query,
    stats: {
      total: dockets.length,
      open: counts.open || 0,
      picked_up: counts.picked_up || 0,
      returned: counts.returned || 0,
      closed: counts.closed || 0,
    }
  });
});

// NEW
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number DESC").all();
  res.render('equipment/hire-dockets/new', {
    title: 'New Hire Docket',
    currentPage: 'equipment',
    jobs,
    today: new Date().toISOString().split('T')[0],
  });
});

// CREATE
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const docketNumber = nextDocketNumber(db);

  const result = db.prepare(`
    INSERT INTO hire_dockets (
      docket_number, job_number, job_id, date_prepared, site_location,
      prepared_by, prepared_by_contact, supervisor, crew,
      supplier_name, supplier_hire_ref, supplier_contact, supplier_phone,
      pickup_address, hire_period, agreed_rate,
      created_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docketNumber,
    b.job_number || '',
    b.job_id ? parseInt(b.job_id, 10) : null,
    b.date_prepared || null,
    b.site_location || '',
    b.prepared_by || req.session.user.full_name || '',
    b.prepared_by_contact || '',
    b.supervisor || '',
    b.crew || '',
    b.supplier_name || '',
    b.supplier_hire_ref || '',
    b.supplier_contact || '',
    b.supplier_phone || '',
    b.pickup_address || '',
    b.hire_period || '',
    b.agreed_rate || '',
    req.session.user.id,
  );

  logActivity({
    user: req.session.user, action: 'create', entityType: 'hire_docket',
    entityId: result.lastInsertRowid, entityLabel: docketNumber, ip: req.ip
  });
  req.flash('success', `Hire docket ${docketNumber} created.`);
  res.redirect(`/equipment/hire-dockets/${result.lastInsertRowid}`);
});

// SHOW
router.get('/:id', (req, res) => {
  const db = getDb();
  const docket = db.prepare(`
    SELECT hd.*, j.job_number as linked_job_number, j.client as linked_client
    FROM hire_dockets hd LEFT JOIN jobs j ON hd.job_id = j.id
    WHERE hd.id = ?
  `).get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }

  const items = db.prepare(`
    SELECT * FROM hire_docket_items WHERE docket_id = ? ORDER BY position ASC, id ASC
  `).all(docket.id);

  items.forEach(it => {
    it.pickup_roadworthy_set = new Set((it.pickup_roadworthy || '').split(',').filter(Boolean));
    it.dropoff_roadworthy_set = new Set((it.dropoff_roadworthy || '').split(',').filter(Boolean));
  });

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number DESC").all();
  const equipment = db.prepare("SELECT id, asset_number, name, registration, serial_number FROM equipment WHERE active = 1 AND ownership_type = 'hired' ORDER BY asset_number").all();

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'hire_docket' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(docket.id);

  res.render('equipment/hire-dockets/show', {
    title: `Hire Docket ${docket.docket_number}`,
    currentPage: 'equipment',
    docket, items, jobs, equipment, activities,
    roadworthyKeys: ROADWORTHY_KEYS,
    fuelLevels: FUEL_LEVELS,
    print: req.query.print === '1',
  });
});

// UPDATE HEADER
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const docket = db.prepare('SELECT id, docket_number FROM hire_dockets WHERE id = ?').get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }

  const status = STATUSES.includes(b.status) ? b.status : 'open';

  db.prepare(`
    UPDATE hire_dockets SET
      job_number = ?, job_id = ?, date_prepared = ?, site_location = ?,
      prepared_by = ?, prepared_by_contact = ?, supervisor = ?, crew = ?,
      supplier_name = ?, supplier_hire_ref = ?, supplier_contact = ?, supplier_phone = ?,
      pickup_address = ?, hire_period = ?, agreed_rate = ?,
      pickup_notes = ?, dropoff_notes = ?,
      pickup_collected_by = ?, pickup_signature = ?, pickup_date = ?, pickup_supplier_rep = ?,
      dropoff_returned_by = ?, dropoff_signature = ?, dropoff_date = ?, dropoff_supplier_rep = ?,
      status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    b.job_number || '',
    b.job_id ? parseInt(b.job_id, 10) : null,
    b.date_prepared || null,
    b.site_location || '',
    b.prepared_by || '',
    b.prepared_by_contact || '',
    b.supervisor || '',
    b.crew || '',
    b.supplier_name || '',
    b.supplier_hire_ref || '',
    b.supplier_contact || '',
    b.supplier_phone || '',
    b.pickup_address || '',
    b.hire_period || '',
    b.agreed_rate || '',
    b.pickup_notes || '',
    b.dropoff_notes || '',
    b.pickup_collected_by || '',
    b.pickup_signature || '',
    b.pickup_date || null,
    b.pickup_supplier_rep || '',
    b.dropoff_returned_by || '',
    b.dropoff_signature || '',
    b.dropoff_date || null,
    b.dropoff_supplier_rep || '',
    status,
    docket.id,
  );

  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number, ip: req.ip
  });
  req.flash('success', 'Docket updated.');
  res.redirect(`/equipment/hire-dockets/${docket.id}`);
});

// DELETE DOCKET
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const docket = db.prepare('SELECT id, docket_number FROM hire_dockets WHERE id = ?').get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }
  db.prepare('DELETE FROM hire_dockets WHERE id = ?').run(docket.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number, ip: req.ip
  });
  req.flash('success', `Hire docket ${docket.docket_number} deleted.`);
  res.redirect('/equipment/hire-dockets');
});

// ADD ITEM
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const docket = db.prepare('SELECT id FROM hire_dockets WHERE id = ?').get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }

  const b = req.body;
  const nextPos = (db.prepare('SELECT MAX(position) as m FROM hire_docket_items WHERE docket_id = ?').get(docket.id).m || 0) + 1;

  db.prepare(`
    INSERT INTO hire_docket_items (
      docket_id, position, equipment_type, rego_serial, asset_id, equipment_id,
      quantity, summary_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docket.id,
    nextPos,
    b.equipment_type || '',
    b.rego_serial || '',
    b.asset_id || '',
    b.equipment_id ? parseInt(b.equipment_id, 10) : null,
    parseInt(b.quantity, 10) || 1,
    b.summary_notes || '',
  );

  req.flash('success', 'Item added.');
  res.redirect(`/equipment/hire-dockets/${docket.id}`);
});

// UPDATE ITEM (full inspection — pick-up + drop-off)
router.post('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const docket = db.prepare('SELECT id, docket_number FROM hire_dockets WHERE id = ?').get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }
  const item = db.prepare('SELECT id FROM hire_docket_items WHERE id = ? AND docket_id = ?').get(req.params.itemId, docket.id);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect(`/equipment/hire-dockets/${docket.id}`); }

  const b = req.body;

  db.prepare(`
    UPDATE hire_docket_items SET
      equipment_type = ?, rego_serial = ?, asset_id = ?, equipment_id = ?,
      quantity = ?, summary_notes = ?,
      pickup_datetime = ?, pickup_hours_odometer = ?, pickup_fuel = ?,
      pickup_damage_observed = ?, pickup_photos_taken = ?, pickup_damage_notes = ?,
      pickup_roadworthy = ?, pickup_accessories = ?, pickup_clean = ?, pickup_initials = ?,
      dropoff_datetime = ?, dropoff_hours_odometer = ?, dropoff_fuel = ?,
      dropoff_damage_observed = ?, dropoff_photos_taken = ?, dropoff_damage_notes = ?,
      dropoff_roadworthy = ?, dropoff_accessories = ?, dropoff_clean = ?, dropoff_initials = ?
    WHERE id = ?
  `).run(
    b.equipment_type || '',
    b.rego_serial || '',
    b.asset_id || '',
    b.equipment_id ? parseInt(b.equipment_id, 10) : null,
    parseInt(b.quantity, 10) || 1,
    b.summary_notes || '',
    b.pickup_datetime || null,
    b.pickup_hours_odometer || '',
    FUEL_LEVELS.includes(b.pickup_fuel) ? b.pickup_fuel : '',
    b.pickup_damage_observed ? 1 : 0,
    b.pickup_photos_taken ? 1 : 0,
    b.pickup_damage_notes || '',
    roadworthyCsv(b, 'pickup'),
    b.pickup_accessories || '',
    b.pickup_clean ? 1 : 0,
    b.pickup_initials || '',
    b.dropoff_datetime || null,
    b.dropoff_hours_odometer || '',
    FUEL_LEVELS.includes(b.dropoff_fuel) ? b.dropoff_fuel : '',
    b.dropoff_damage_observed ? 1 : 0,
    b.dropoff_photos_taken ? 1 : 0,
    b.dropoff_damage_notes || '',
    roadworthyCsv(b, 'dropoff'),
    b.dropoff_accessories || '',
    b.dropoff_clean ? 1 : 0,
    b.dropoff_initials || '',
    item.id,
  );

  db.prepare('UPDATE hire_dockets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(docket.id);

  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: `${docket.docket_number} item ${item.id}`, ip: req.ip
  });
  req.flash('success', 'Item inspection saved.');
  res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`);
});

// DELETE ITEM
router.post('/:id/items/:itemId/delete', (req, res) => {
  const db = getDb();
  const docket = db.prepare('SELECT id FROM hire_dockets WHERE id = ?').get(req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return res.redirect('/equipment/hire-dockets'); }
  db.prepare('DELETE FROM hire_docket_items WHERE id = ? AND docket_id = ?').run(req.params.itemId, docket.id);
  req.flash('success', 'Item removed.');
  res.redirect(`/equipment/hire-dockets/${docket.id}`);
});

module.exports = router;
