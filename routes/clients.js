const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// List all clients
router.get('/', (req, res) => {
  const db = getDb();
  const { search, status } = req.query;
  let query = `
    SELECT c.*,
      (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id AND j.status IN ('active','on_hold','won')) as active_jobs,
      (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id) as total_jobs
    FROM clients c WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ` AND (c.company_name LIKE ? OR c.abn LIKE ? OR c.primary_contact_name LIKE ? OR c.primary_contact_email LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (status === 'active') {
    query += ` AND c.active = 1`;
  } else if (status === 'inactive') {
    query += ` AND c.active = 0`;
  }

  query += ` ORDER BY c.company_name ASC`;
  const clients = db.prepare(query).all(...params);

  res.render('clients/index', {
    title: 'Client Register',
    currentPage: 'clients',
    clients,
    filters: { search, status },
  });
});

// New client form
router.get('/new', (req, res) => {
  res.render('clients/form', {
    title: 'Add New Client',
    currentPage: 'clients',
    client: null,
  });
});

// Create client
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO clients (company_name, abn, primary_contact_name, primary_contact_phone, primary_contact_email, address, billing_address, payment_terms, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.company_name, b.abn || '', b.primary_contact_name || '', b.primary_contact_phone || '',
      b.primary_contact_email || '', b.address || '', b.billing_address || '',
      b.payment_terms || '', b.notes || ''
    );
    req.flash('success', `Client "${b.company_name}" created successfully.`);

    // If request wants JSON (from inline create on allocations board)
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      const newClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
      return res.json({ success: true, client: newClient });
    }

    res.redirect('/clients/' + result.lastInsertRowid);
  } catch (err) {
    req.flash('error', 'Failed to create client: ' + err.message);
    res.redirect('/clients/new');
  }
});

// Client detail page
router.get('/:id', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) {
    req.flash('error', 'Client not found.');
    return res.redirect('/clients');
  }

  // Contacts for this client (from client_contacts where company matches, or job-linked)
  const projects = db.prepare(`
    SELECT j.*, u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.client_id = ? AND j.parent_project_id IS NULL
    ORDER BY j.start_date DESC
  `).all(client.id);

  const recentShifts = db.prepare(`
    SELECT j.*, u.full_name as pm_name,
      (SELECT COUNT(*) FROM crew_allocations ca WHERE ca.job_id = j.id AND ca.status IN ('allocated','confirmed')) as crew_count
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.client_id = ? AND j.parent_project_id IS NOT NULL
    ORDER BY j.start_date DESC LIMIT 20
  `).all(client.id);

  // Job-level contacts associated with this client's jobs
  const contacts = db.prepare(`
    SELECT cc.* FROM client_contacts cc
    JOIN jobs j ON cc.job_id = j.id
    WHERE j.client_id = ?
    GROUP BY cc.full_name, cc.email
    ORDER BY cc.is_primary DESC, cc.full_name ASC
  `).all(client.id);

  res.render('clients/show', {
    title: client.company_name,
    currentPage: 'clients',
    client,
    projects,
    recentShifts,
    contacts,
  });
});

// Edit client form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) {
    req.flash('error', 'Client not found.');
    return res.redirect('/clients');
  }
  res.render('clients/form', {
    title: 'Edit Client',
    currentPage: 'clients',
    client,
  });
});

// Update client
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    db.prepare(`
      UPDATE clients SET company_name=?, abn=?, primary_contact_name=?, primary_contact_phone=?,
        primary_contact_email=?, address=?, billing_address=?, payment_terms=?, notes=?,
        active=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.company_name, b.abn || '', b.primary_contact_name || '', b.primary_contact_phone || '',
      b.primary_contact_email || '', b.address || '', b.billing_address || '',
      b.payment_terms || '', b.notes || '', b.active ? 1 : 0,
      req.params.id
    );
    req.flash('success', 'Client updated successfully.');
    res.redirect('/clients/' + req.params.id);
  } catch (err) {
    req.flash('error', 'Failed to update client: ' + err.message);
    res.redirect('/clients/' + req.params.id + '/edit');
  }
});

// Delete client
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  // Only allow delete if no jobs are linked
  const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs WHERE client_id = ?').get(req.params.id).count;
  if (jobCount > 0) {
    req.flash('error', 'Cannot delete client with linked projects/shifts. Deactivate instead.');
    return res.redirect('/clients/' + req.params.id);
  }
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  req.flash('success', 'Client deleted.');
  res.redirect('/clients');
});

// JSON API - search clients (for autocomplete/dropdowns)
router.get('/api/search.json', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  const clients = db.prepare(`
    SELECT id, company_name, abn, primary_contact_name, primary_contact_phone
    FROM clients WHERE active = 1 AND (company_name LIKE ? OR abn LIKE ?)
    ORDER BY company_name ASC LIMIT 20
  `).all(`%${q}%`, `%${q}%`);
  res.json(clients);
});

module.exports = router;
