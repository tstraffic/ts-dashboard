const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'tstraffic.db');

function runMigrations(db) {
  // Create migration tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const isMigrationApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
  const recordMigration = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  // =============================================
  // Migration 1: Job Register Improvements
  // =============================================
  if (!isMigrationApplied.get(1)) {
    console.log('Running migration 1: Job Register Improvements');

    // Add new columns to jobs (use try/catch for each since column may already exist)
    const newJobCols = [
      "ALTER TABLE jobs ADD COLUMN client_project_number TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN project_name TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN principal_contractor TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN traffic_supervisor_id INTEGER REFERENCES users(id)",
      "ALTER TABLE jobs ADD COLUMN contract_value REAL DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN estimated_hours REAL DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN crew_size INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN rol_required INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN tmp_required INTEGER DEFAULT 0",
      "ALTER TABLE jobs ADD COLUMN sharepoint_url TEXT DEFAULT ''",
      "ALTER TABLE jobs ADD COLUMN state TEXT DEFAULT 'NSW'",
    ];
    for (const sql of newJobCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate jobs table to update status CHECK constraint
    // Check if migration is already done by looking for 'tender' in the CHECK constraint
    let needsRecreate = true;
    try {
      // If we can insert 'tender' status, the new CHECK is already in place
      db.exec("CREATE TABLE _migration_test_jobs AS SELECT * FROM jobs WHERE 0");
      db.exec("DROP TABLE _migration_test_jobs");
      // Try a more reliable check: see if the old constraint rejects 'tender'
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'tender'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed with recreation */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE jobs_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_number TEXT UNIQUE NOT NULL,
            job_name TEXT NOT NULL,
            client TEXT NOT NULL,
            site_address TEXT NOT NULL,
            suburb TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'tender' CHECK(status IN ('tender','won','prestart','active','on_hold','completed','closed')),
            stage TEXT NOT NULL DEFAULT 'tender' CHECK(stage IN ('tender','prestart','delivery','closeout')),
            percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete >= 0 AND percent_complete <= 100),
            start_date DATE NOT NULL,
            end_date DATE,
            project_manager_id INTEGER REFERENCES users(id),
            ops_supervisor_id INTEGER REFERENCES users(id),
            planning_owner_id INTEGER REFERENCES users(id),
            marketing_owner_id INTEGER REFERENCES users(id),
            accounts_owner_id INTEGER REFERENCES users(id),
            health TEXT NOT NULL DEFAULT 'green' CHECK(health IN ('green','amber','red')),
            accounts_status TEXT NOT NULL DEFAULT 'na' CHECK(accounts_status IN ('na','on_track','overdue','disputed')),
            division_tags TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            last_update_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            client_project_number TEXT DEFAULT '',
            project_name TEXT DEFAULT '',
            principal_contractor TEXT DEFAULT '',
            traffic_supervisor_id INTEGER REFERENCES users(id),
            contract_value REAL DEFAULT 0,
            estimated_hours REAL DEFAULT 0,
            crew_size INTEGER DEFAULT 0,
            rol_required INTEGER DEFAULT 0,
            tmp_required INTEGER DEFAULT 0,
            sharepoint_url TEXT DEFAULT '',
            state TEXT DEFAULT 'NSW'
          );
        `);

        db.exec(`
          INSERT INTO jobs_new (
            id, job_number, job_name, client, site_address, suburb,
            status, stage, percent_complete, start_date, end_date,
            project_manager_id, ops_supervisor_id, planning_owner_id,
            marketing_owner_id, accounts_owner_id, health, accounts_status,
            division_tags, notes, last_update_date, created_at, updated_at,
            client_project_number, project_name, principal_contractor,
            traffic_supervisor_id, contract_value, estimated_hours,
            crew_size, rol_required, tmp_required, sharepoint_url, state
          )
          SELECT
            id, job_number, job_name, client, site_address, suburb,
            CASE status WHEN 'lead' THEN 'tender' WHEN 'lost' THEN 'closed' ELSE status END,
            stage, percent_complete, start_date, end_date,
            project_manager_id, ops_supervisor_id, planning_owner_id,
            marketing_owner_id, accounts_owner_id, health, accounts_status,
            division_tags, notes, last_update_date, created_at, updated_at,
            client_project_number, project_name, principal_contractor,
            traffic_supervisor_id, contract_value, estimated_hours,
            crew_size, rol_required, tmp_required, sharepoint_url, state
          FROM jobs;
        `);

        db.exec('DROP TABLE jobs');
        db.exec('ALTER TABLE jobs_new RENAME TO jobs');

        // Recreate all indexes on jobs
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
          CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);
          CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
          CREATE INDEX IF NOT EXISTS idx_jobs_suburb ON jobs(suburb);
          CREATE INDEX IF NOT EXISTS idx_jobs_health ON jobs(health);
          CREATE INDEX IF NOT EXISTS idx_jobs_pm ON jobs(project_manager_id);
          CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(1, 'Job Register Improvements');
    console.log('Migration 1 complete.');
  }

  // =============================================
  // Migration 2: Audit Log Enhancement
  // =============================================
  if (!isMigrationApplied.get(2)) {
    console.log('Running migration 2: Audit Log Enhancement');

    const auditCols = [
      "ALTER TABLE activity_log ADD COLUMN before_value TEXT DEFAULT ''",
      "ALTER TABLE activity_log ADD COLUMN after_value TEXT DEFAULT ''",
    ];
    for (const sql of auditCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(2, 'Audit Log Enhancement');
    console.log('Migration 2 complete.');
  }

  // =============================================
  // Migration 3: Crew Competency
  // =============================================
  if (!isMigrationApplied.get(3)) {
    console.log('Running migration 3: Crew Competency');

    const crewCols = [
      "ALTER TABLE crew_members ADD COLUMN tcp_level TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN white_card TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN white_card_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN first_aid TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN first_aid_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN tc_ticket TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN tc_ticket_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN ti_ticket TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN ti_ticket_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN induction_status TEXT DEFAULT 'pending'",
      "ALTER TABLE crew_members ADD COLUMN company TEXT DEFAULT ''",
      "ALTER TABLE crew_members ADD COLUMN medical_expiry DATE",
      "ALTER TABLE crew_members ADD COLUMN employment_type TEXT DEFAULT 'employee'",
      "ALTER TABLE crew_members ADD COLUMN status TEXT DEFAULT 'active'",
    ];
    for (const sql of crewCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(3, 'Crew Competency');
    console.log('Migration 3 complete.');
  }

  // =============================================
  // Migration 4: Equipment Register
  // =============================================
  if (!isMigrationApplied.get(4)) {
    console.log('Running migration 4: Equipment Register');

    const equipCols = [
      "ALTER TABLE equipment ADD COLUMN registration TEXT DEFAULT ''",
      "ALTER TABLE equipment ADD COLUMN location TEXT DEFAULT ''",
    ];
    for (const sql of equipCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate equipment table to expand category CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='equipment'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'ute'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE equipment_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            asset_number TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('ute','truck','arrow_board','vms_board','trailer','barriers','signs','lights','cone','delineator','vehicle','lighting','barrier','sign','vms','other')),
            description TEXT DEFAULT '',
            serial_number TEXT DEFAULT '',
            purchase_date DATE,
            purchase_cost REAL DEFAULT 0,
            current_condition TEXT NOT NULL DEFAULT 'good' CHECK(current_condition IN ('new','good','fair','poor','damaged','decommissioned')),
            storage_location TEXT DEFAULT '',
            next_inspection_date DATE,
            inspection_interval_days INTEGER DEFAULT 90,
            notes TEXT DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            registration TEXT DEFAULT '',
            location TEXT DEFAULT ''
          );
        `);

        db.exec(`
          INSERT INTO equipment_new (
            id, asset_number, name, category, description, serial_number,
            purchase_date, purchase_cost, current_condition, storage_location,
            next_inspection_date, inspection_interval_days, notes, active,
            created_at, updated_at, registration, location
          )
          SELECT
            id, asset_number, name, category, description, serial_number,
            purchase_date, purchase_cost, current_condition, storage_location,
            next_inspection_date, inspection_interval_days, notes, active,
            created_at, updated_at, registration, location
          FROM equipment;
        `);

        db.exec('DROP TABLE equipment');
        db.exec('ALTER TABLE equipment_new RENAME TO equipment');

        // Recreate all indexes on equipment
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category);
          CREATE INDEX IF NOT EXISTS idx_equipment_active ON equipment(active);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(4, 'Equipment Register');
    console.log('Migration 4 complete.');
  }

  // =============================================
  // Migration 5: Incident Upgrade
  // =============================================
  if (!isMigrationApplied.get(5)) {
    console.log('Running migration 5: Incident Upgrade');

    const incidentCols = [
      "ALTER TABLE incidents ADD COLUMN traffic_disruption TEXT DEFAULT ''",
      "ALTER TABLE incidents ADD COLUMN police_notified INTEGER DEFAULT 0",
      "ALTER TABLE incidents ADD COLUMN client_notified INTEGER DEFAULT 0",
      "ALTER TABLE incidents ADD COLUMN close_out_date DATE",
    ];
    for (const sql of incidentCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Recreate incidents table to expand incident_type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='incidents'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'traffic_incident'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE incidents_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            incident_number TEXT UNIQUE NOT NULL,
            incident_type TEXT NOT NULL CHECK(incident_type IN ('near_miss','traffic_incident','worker_injury','vehicle_damage','public_complaint','environmental','injury','hazard','property_damage','vehicle','other')),
            severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            location TEXT DEFAULT '',
            incident_date DATE NOT NULL,
            incident_time TEXT DEFAULT '',
            reported_by_id INTEGER NOT NULL REFERENCES users(id),
            persons_involved TEXT DEFAULT '',
            witnesses TEXT DEFAULT '',
            immediate_actions TEXT DEFAULT '',
            root_cause TEXT DEFAULT '',
            investigation_status TEXT NOT NULL DEFAULT 'reported' CHECK(investigation_status IN ('reported','investigating','resolved','closed')),
            notifiable_incident INTEGER NOT NULL DEFAULT 0,
            photo_path TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            traffic_disruption TEXT DEFAULT '',
            police_notified INTEGER DEFAULT 0,
            client_notified INTEGER DEFAULT 0,
            close_out_date DATE
          );
        `);

        db.exec(`
          INSERT INTO incidents_new (
            id, job_id, incident_number, incident_type, severity, title,
            description, location, incident_date, incident_time, reported_by_id,
            persons_involved, witnesses, immediate_actions, root_cause,
            investigation_status, notifiable_incident, photo_path,
            created_at, updated_at, traffic_disruption, police_notified,
            client_notified, close_out_date
          )
          SELECT
            id, job_id, incident_number, incident_type, severity, title,
            description, location, incident_date, incident_time, reported_by_id,
            persons_involved, witnesses, immediate_actions, root_cause,
            investigation_status, notifiable_incident, photo_path,
            created_at, updated_at, traffic_disruption, police_notified,
            client_notified, close_out_date
          FROM incidents;
        `);

        db.exec('DROP TABLE incidents');
        db.exec('ALTER TABLE incidents_new RENAME TO incidents');

        // Recreate all indexes on incidents
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_incidents_job ON incidents(job_id);
          CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(investigation_status);
          CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
          CREATE INDEX IF NOT EXISTS idx_incidents_date ON incidents(incident_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(5, 'Incident Upgrade');
    console.log('Migration 5 complete.');
  }

  // =============================================
  // Migration 6: Compliance Register
  // =============================================
  if (!isMigrationApplied.get(6)) {
    console.log('Running migration 6: Compliance Register');

    // Recreate compliance table to expand item_type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='compliance'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'rol'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE compliance_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','other')),
            title TEXT NOT NULL,
            authority_approver TEXT DEFAULT '',
            internal_approver_id INTEGER REFERENCES users(id),
            due_date DATE NOT NULL,
            submitted_date DATE,
            approved_date DATE,
            expiry_date DATE,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
            document_path TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        db.exec(`
          INSERT INTO compliance_new (
            id, job_id, item_type, title, authority_approver, internal_approver_id,
            due_date, submitted_date, approved_date, expiry_date, status,
            document_path, notes, created_at, updated_at
          )
          SELECT
            id, job_id, item_type, title, authority_approver, internal_approver_id,
            due_date, submitted_date, approved_date, expiry_date, status,
            document_path, notes, created_at, updated_at
          FROM compliance;
        `);

        db.exec('DROP TABLE compliance');
        db.exec('ALTER TABLE compliance_new RENAME TO compliance');

        // Recreate all indexes on compliance
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
          CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
          CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(6, 'Compliance Register');
    console.log('Migration 6 complete.');
  }

  // =============================================
  // Migration 7: Notification Expansion
  // =============================================
  if (!isMigrationApplied.get(7)) {
    console.log('Running migration 7: Notification Expansion');

    // Recreate notifications table to expand type CHECK
    let needsRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'rol_pending'")) {
        needsRecreate = false;
      }
    } catch (e) { /* proceed */ }

    if (needsRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','new_incident','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','timesheet_approval','budget_alert','general','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue')),
            title TEXT NOT NULL,
            message TEXT NOT NULL,
            link TEXT DEFAULT '',
            job_id INTEGER REFERENCES jobs(id),
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        db.exec(`
          INSERT INTO notifications_new (
            id, user_id, type, title, message, link, job_id, is_read, created_at
          )
          SELECT
            id, user_id, type, title, message, link, job_id, is_read, created_at
          FROM notifications;
        `);

        db.exec('DROP TABLE notifications');
        db.exec('ALTER TABLE notifications_new RENAME TO notifications');

        // Recreate all indexes on notifications
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        `);

        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    recordMigration.run(7, 'Notification Expansion');
    console.log('Migration 7 complete.');
  }

  // =============================================
  // Migration 8: Traffic Plans table (NEW)
  // =============================================
  if (!isMigrationApplied.get(8)) {
    console.log('Running migration 8: Traffic Plans table');

    db.exec(`
      CREATE TABLE IF NOT EXISTS traffic_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        plan_number TEXT UNIQUE NOT NULL,
        plan_type TEXT NOT NULL CHECK(plan_type IN ('TGS','TCP','TMP')),
        designer TEXT DEFAULT '',
        rol_required INTEGER DEFAULT 0,
        rol_submitted INTEGER DEFAULT 0,
        rol_approved INTEGER DEFAULT 0,
        council TEXT DEFAULT '',
        tfnsw TEXT DEFAULT '',
        submitted_date DATE,
        approval_date DATE,
        approved_date DATE,
        expiry_date DATE,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','under_review','approved','rejected','expired')),
        file_link TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_traffic_plans_job ON traffic_plans(job_id);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_status ON traffic_plans(status);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_type ON traffic_plans(plan_type);
      CREATE INDEX IF NOT EXISTS idx_traffic_plans_expiry ON traffic_plans(expiry_date);
    `);

    recordMigration.run(8, 'Traffic Plans table');
    console.log('Migration 8 complete.');
  }

  // =============================================
  // Migration 9: Budget Enhancements
  // =============================================
  if (!isMigrationApplied.get(9)) {
    console.log('Running migration 9: Budget Enhancements');

    const budgetCols = [
      "ALTER TABLE cost_entries ADD COLUMN receipt_url TEXT DEFAULT ''",
      "ALTER TABLE job_budgets ADD COLUMN budget_contingency REAL NOT NULL DEFAULT 0",
    ];
    for (const sql of budgetCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Expand notifications type CHECK to include over_budget
    let needsNotifRecreate = true;
    try {
      const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      if (tableInfo && tableInfo.sql && tableInfo.sql.includes("'over_budget'")) {
        needsNotifRecreate = false;
      }
    } catch (e) { }

    if (needsNotifRecreate) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE notifications_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue','over_budget','general')),
            title TEXT NOT NULL,
            message TEXT NOT NULL DEFAULT '',
            link TEXT DEFAULT '',
            job_id INTEGER REFERENCES jobs(id),
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO notifications_new SELECT * FROM notifications;
          DROP TABLE notifications;
          ALTER TABLE notifications_new RENAME TO notifications;
          CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
          CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
          CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
        `);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) { }
        console.log('Notification table recreation skipped:', e.message);
      }
    }

    recordMigration.run(9, 'Budget Enhancements');
    console.log('Migration 9 complete.');
  }

  // =============================================
  // Migration 10: Crew Allocations (Booking Board)
  // =============================================
  if (!isMigrationApplied.get(10)) {
    console.log('Running migration 10: Crew Allocations');

    db.exec(`
      CREATE TABLE IF NOT EXISTS crew_allocations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        allocation_date DATE NOT NULL,
        start_time TEXT DEFAULT '06:00',
        end_time TEXT DEFAULT '14:30',
        shift_type TEXT NOT NULL DEFAULT 'day' CHECK(shift_type IN ('day','night','split')),
        role_on_site TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'allocated' CHECK(status IN ('allocated','confirmed','declined','completed','cancelled')),
        notes TEXT DEFAULT '',
        allocated_by_id INTEGER NOT NULL REFERENCES users(id),
        confirmed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_crew_alloc_date ON crew_allocations(allocation_date);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_job ON crew_allocations(job_id);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_crew ON crew_allocations(crew_member_id);
      CREATE INDEX IF NOT EXISTS idx_crew_alloc_status ON crew_allocations(status);
    `);

    recordMigration.run(10, 'Crew Allocations');
    console.log('Migration 10 complete.');
  }

  // =============================================
  // Migration 11: Integration Hooks
  // =============================================
  if (!isMigrationApplied.get(11)) {
    console.log('Running migration 11: Integration Hooks');

    db.exec(`
      CREATE TABLE IF NOT EXISTS integration_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL UNIQUE CHECK(provider IN ('traffio','quickbooks','employment_hero','teams','sharepoint')),
        enabled INTEGER NOT NULL DEFAULT 0,
        config_json TEXT DEFAULT '{}',
        last_sync_at DATETIME,
        sync_status TEXT DEFAULT 'never' CHECK(sync_status IN ('never','syncing','success','error')),
        error_message TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('import','export','webhook')),
        entity_type TEXT NOT NULL,
        records_processed INTEGER DEFAULT 0,
        records_created INTEGER DEFAULT 0,
        records_updated INTEGER DEFAULT 0,
        records_failed INTEGER DEFAULT 0,
        error_details TEXT DEFAULT '',
        triggered_by TEXT DEFAULT 'manual',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS external_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        internal_id INTEGER NOT NULL,
        external_id TEXT NOT NULL,
        external_data TEXT DEFAULT '{}',
        last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, entity_type, internal_id),
        UNIQUE(provider, entity_type, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ext_refs_lookup ON external_refs(provider, entity_type, external_id);
      CREATE INDEX IF NOT EXISTS idx_sync_log_provider ON sync_log(provider, started_at);
    `);

    // Seed default provider rows (all disabled)
    const seedProvider = db.prepare(`INSERT OR IGNORE INTO integration_config (provider) VALUES (?)`);
    seedProvider.run('traffio');
    seedProvider.run('quickbooks');
    seedProvider.run('employment_hero');
    seedProvider.run('teams');
    seedProvider.run('sharepoint');

    recordMigration.run(11, 'Integration Hooks');
    console.log('Migration 11 complete.');
  }

  // =============================================
  // Migration 12: Sprint 1 — Worker Profile & Allocation Blocking
  // =============================================
  if (!isMigrationApplied.get(12)) {
    console.log('Running migration 12: Worker Profile & Allocation Blocking');

    // 1. Supervisor approval fields on crew_members
    const crewCols = [
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved INTEGER DEFAULT 0",
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved_by_id INTEGER REFERENCES users(id)",
      "ALTER TABLE crew_members ADD COLUMN supervisor_approved_at DATETIME",
    ];
    for (const sql of crewCols) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    // 2. Required TCP level on jobs
    try {
      db.exec("ALTER TABLE jobs ADD COLUMN required_tcp_level TEXT DEFAULT ''");
    } catch (e) { /* column may already exist */ }

    // 3. Incident ↔ crew member link table
    db.exec(`
      CREATE TABLE IF NOT EXISTS incident_crew_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        involvement_type TEXT NOT NULL DEFAULT 'involved'
          CHECK(involvement_type IN ('involved','witness','injured','reporting')),
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(incident_id, crew_member_id)
      );
      CREATE INDEX IF NOT EXISTS idx_incident_crew_incident ON incident_crew_members(incident_id);
      CREATE INDEX IF NOT EXISTS idx_incident_crew_member ON incident_crew_members(crew_member_id);
    `);

    recordMigration.run(12, 'Worker Profile & Allocation Blocking');
    console.log('Migration 12 complete.');
  }

  // =============================================
  // Migration 13: Settings & Configuration Module
  // =============================================
  if (!isMigrationApplied.get(13)) {
    console.log('Running migration 13: Settings & Configuration Module');

    // 1. App Settings table — stores all configurable enumerations
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        color TEXT DEFAULT '',
        icon TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(category, key)
      );
      CREATE INDEX IF NOT EXISTS idx_app_settings_category ON app_settings(category);
      CREATE INDEX IF NOT EXISTS idx_app_settings_active ON app_settings(category, is_active);
    `);

    // 2. System Config table — key-value store for operational parameters
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_key TEXT NOT NULL UNIQUE,
        config_value TEXT NOT NULL DEFAULT '',
        config_type TEXT DEFAULT 'string',
        description TEXT DEFAULT '',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by_id INTEGER REFERENCES users(id)
      );
    `);

    // 3. Seed all enumeration settings
    const insertSetting = db.prepare(`
      INSERT OR IGNORE INTO app_settings (category, key, label, display_order, is_active, color)
      VALUES (?, ?, ?, ?, 1, ?)
    `);

    const seedCategory = (category, items) => {
      items.forEach((item, idx) => {
        const key = typeof item === 'string' ? item : item.key;
        const label = typeof item === 'string'
          ? item.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          : item.label;
        const color = (typeof item === 'object' && item.color) ? item.color : '';
        insertSetting.run(category, key, label, idx + 1, color);
      });
    };

    // Job statuses
    seedCategory('job_status', [
      { key: 'tender', label: 'Tender', color: 'slate' },
      { key: 'won', label: 'Won', color: 'emerald' },
      { key: 'prestart', label: 'Prestart', color: 'sky' },
      { key: 'active', label: 'Active', color: 'green' },
      { key: 'on_hold', label: 'On Hold', color: 'amber' },
      { key: 'completed', label: 'Completed', color: 'blue' },
      { key: 'closed', label: 'Closed', color: 'gray' },
    ]);

    // Job stages
    seedCategory('job_stage', [
      { key: 'tender', label: 'Tender' },
      { key: 'pre_construction', label: 'Pre-Construction' },
      { key: 'mobilisation', label: 'Mobilisation' },
      { key: 'in_progress', label: 'In Progress' },
      { key: 'delivery', label: 'Delivery' },
      { key: 'demobilisation', label: 'Demobilisation' },
      { key: 'defects', label: 'Defects' },
      { key: 'closed', label: 'Closed' },
    ]);

    // Job health
    seedCategory('job_health', [
      { key: 'green', label: 'Green', color: 'green' },
      { key: 'amber', label: 'Amber', color: 'amber' },
      { key: 'red', label: 'Red', color: 'red' },
    ]);

    // Accounts status
    seedCategory('accounts_status', [
      { key: 'na', label: 'N/A', color: 'slate' },
      { key: 'on_track', label: 'On Track', color: 'green' },
      { key: 'overdue', label: 'Overdue', color: 'red' },
      { key: 'disputed', label: 'Disputed', color: 'amber' },
    ]);

    // TC levels
    seedCategory('tcp_level', [
      { key: 'beginner', label: 'Beginner' },
      { key: 'intermediate', label: 'Intermediate' },
      { key: 'team_leader', label: 'Team Leader' },
      { key: 'supervisor', label: 'Supervisor' },
    ]);

    // Incident types
    seedCategory('incident_type', [
      { key: 'near_miss', label: 'Near Miss', color: 'amber' },
      { key: 'traffic_incident', label: 'Traffic Incident', color: 'red' },
      { key: 'worker_injury', label: 'Worker Injury', color: 'red' },
      { key: 'vehicle_damage', label: 'Vehicle Damage', color: 'orange' },
      { key: 'public_complaint', label: 'Public Complaint', color: 'purple' },
      { key: 'injury', label: 'Injury', color: 'red' },
      { key: 'hazard', label: 'Hazard', color: 'amber' },
      { key: 'property_damage', label: 'Property Damage', color: 'orange' },
      { key: 'environmental', label: 'Environmental', color: 'teal' },
      { key: 'vehicle', label: 'Vehicle', color: 'blue' },
      { key: 'other', label: 'Other', color: 'slate' },
    ]);

    // Incident severity
    seedCategory('incident_severity', [
      { key: 'low', label: 'Low', color: 'green' },
      { key: 'medium', label: 'Medium', color: 'amber' },
      { key: 'high', label: 'High', color: 'orange' },
      { key: 'critical', label: 'Critical', color: 'red' },
    ]);

    // Equipment categories
    seedCategory('equipment_category', [
      { key: 'ute', label: 'Ute' },
      { key: 'truck', label: 'Truck' },
      { key: 'arrow_board', label: 'Arrow Board' },
      { key: 'vms_board', label: 'VMS Board' },
      { key: 'trailer', label: 'Trailer' },
      { key: 'barriers', label: 'Barriers' },
      { key: 'signs', label: 'Signs' },
      { key: 'lights', label: 'Lights' },
      { key: 'vehicle', label: 'Vehicle' },
      { key: 'cone', label: 'Cone' },
      { key: 'delineator', label: 'Delineator' },
      { key: 'other', label: 'Other' },
    ]);

    // Crew roles
    seedCategory('crew_role', [
      { key: 'traffic_controller', label: 'Traffic Controller' },
      { key: 'leading_hand', label: 'Leading Hand' },
      { key: 'supervisor', label: 'Supervisor' },
      { key: 'pilot_vehicle', label: 'Pilot Vehicle' },
      { key: 'spotter', label: 'Spotter' },
      { key: 'labourer', label: 'Labourer' },
      { key: 'other', label: 'Other' },
    ]);

    // Employment types
    seedCategory('employment_type', [
      { key: 'employee', label: 'Employee' },
      { key: 'subcontractor', label: 'Subcontractor' },
      { key: 'casual', label: 'Casual' },
      { key: 'agency', label: 'Agency' },
    ]);

    // Defect severity
    seedCategory('defect_severity', [
      { key: 'minor', label: 'Minor', color: 'green' },
      { key: 'moderate', label: 'Moderate', color: 'amber' },
      { key: 'major', label: 'Major', color: 'orange' },
      { key: 'critical', label: 'Critical', color: 'red' },
    ]);

    // Defect status
    seedCategory('defect_status', [
      { key: 'open', label: 'Open', color: 'red' },
      { key: 'investigating', label: 'Investigating', color: 'amber' },
      { key: 'rectification', label: 'Rectification', color: 'blue' },
      { key: 'closed', label: 'Closed', color: 'green' },
      { key: 'deferred', label: 'Deferred', color: 'slate' },
    ]);

    // Task status
    seedCategory('task_status', [
      { key: 'not_started', label: 'Not Started', color: 'slate' },
      { key: 'in_progress', label: 'In Progress', color: 'blue' },
      { key: 'blocked', label: 'Blocked', color: 'red' },
      { key: 'complete', label: 'Complete', color: 'green' },
    ]);

    // Task priority
    seedCategory('task_priority', [
      { key: 'low', label: 'Low', color: 'green' },
      { key: 'medium', label: 'Medium', color: 'amber' },
      { key: 'high', label: 'High', color: 'red' },
    ]);

    seedCategory('task_type', [
      { key: 'daily', label: 'Daily', color: 'amber' },
      { key: 'weekly', label: 'Weekly', color: 'blue' },
      { key: 'one_off', label: 'One-off', color: 'slate' },
    ]);

    // Traffic plan types
    seedCategory('plan_type', [
      { key: 'TGS', label: 'Traffic Guidance Scheme' },
      { key: 'TCP', label: 'Traffic Control Plan' },
      { key: 'TMP', label: 'Traffic Management Plan' },
    ]);

    // Traffic plan status
    seedCategory('plan_status', [
      { key: 'draft', label: 'Draft', color: 'slate' },
      { key: 'submitted', label: 'Submitted', color: 'blue' },
      { key: 'under_review', label: 'Under Review', color: 'amber' },
      { key: 'approved', label: 'Approved', color: 'green' },
      { key: 'rejected', label: 'Rejected', color: 'red' },
      { key: 'expired', label: 'Expired', color: 'gray' },
    ]);

    // Shift types
    seedCategory('shift_type', [
      { key: 'day', label: 'Day', color: 'amber' },
      { key: 'night', label: 'Night', color: 'indigo' },
      { key: 'split', label: 'Split', color: 'purple' },
    ]);

    // Allocation status
    seedCategory('allocation_status', [
      { key: 'allocated', label: 'Allocated', color: 'blue' },
      { key: 'confirmed', label: 'Confirmed', color: 'green' },
      { key: 'declined', label: 'Declined', color: 'red' },
      { key: 'completed', label: 'Completed', color: 'emerald' },
      { key: 'cancelled', label: 'Cancelled', color: 'slate' },
    ]);

    // Compliance status
    seedCategory('compliance_status', [
      { key: 'not_started', label: 'Not Started', color: 'slate' },
      { key: 'submitted', label: 'Submitted', color: 'blue' },
      { key: 'approved', label: 'Approved', color: 'green' },
      { key: 'rejected', label: 'Rejected', color: 'red' },
      { key: 'expired', label: 'Expired', color: 'gray' },
    ]);

    // Australian states
    seedCategory('state', [
      { key: 'NSW', label: 'New South Wales' },
      { key: 'VIC', label: 'Victoria' },
      { key: 'QLD', label: 'Queensland' },
      { key: 'SA', label: 'South Australia' },
      { key: 'WA', label: 'Western Australia' },
      { key: 'TAS', label: 'Tasmania' },
      { key: 'NT', label: 'Northern Territory' },
      { key: 'ACT', label: 'Australian Capital Territory' },
    ]);

    // 4. Seed system configuration
    const insertConfig = db.prepare(`
      INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
      VALUES (?, ?, ?, ?)
    `);

    insertConfig.run('company_name', 'T&S Traffic Control', 'string', 'Company display name');
    insertConfig.run('company_tagline', 'Operations Dashboard', 'string', 'Dashboard subtitle');
    insertConfig.run('default_timezone', 'Australia/Sydney', 'string', 'Default timezone for dates');
    insertConfig.run('currency', 'AUD', 'string', 'Default currency');
    insertConfig.run('default_shift_hours', '12', 'number', 'Default shift length in hours');
    insertConfig.run('fatigue_max_days', '5', 'number', 'Max work days in fatigue window before blocked');
    insertConfig.run('fatigue_window_days', '7', 'number', 'Rolling window for fatigue calculation (days)');
    insertConfig.run('ticket_expiry_warning_days', '30', 'number', 'Days before ticket expiry to show warning');
    insertConfig.run('max_shift_length_hours', '14', 'number', 'Maximum allowed shift length in hours');
    insertConfig.run('min_rest_between_shifts_hours', '10', 'number', 'Minimum rest period between shifts in hours');

    recordMigration.run(13, 'Settings & Configuration Module');
    console.log('Migration 13 complete.');
  }

  // =============================================
  // Migration 14: Worker Portal Auth
  // =============================================
  if (!isMigrationApplied.get(14)) {
    console.log('Running migration 14: Worker Portal Auth');

    const workerCols = [
      "ALTER TABLE crew_members ADD COLUMN pin_hash TEXT",
      "ALTER TABLE crew_members ADD COLUMN pin_set_at TEXT",
      "ALTER TABLE crew_members ADD COLUMN pin_set_by_id INTEGER",
      "ALTER TABLE crew_members ADD COLUMN last_worker_login TEXT",
      "ALTER TABLE crew_members ADD COLUMN worker_login_count INTEGER DEFAULT 0",
    ];
    for (const sql of workerCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(14, 'Worker Portal Auth');
    console.log('Migration 14 complete.');
  }

  // =============================================
  // Migration 15: Client Register & Project Structure
  // =============================================
  if (!isMigrationApplied.get(15)) {
    console.log('Running migration 15: Client Register & Project Structure');

    // Create clients table
    db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL,
        abn TEXT DEFAULT '',
        primary_contact_name TEXT DEFAULT '',
        primary_contact_phone TEXT DEFAULT '',
        primary_contact_email TEXT DEFAULT '',
        address TEXT DEFAULT '',
        billing_address TEXT DEFAULT '',
        payment_terms TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add client_id and parent_project_id to jobs
    const newCols15 = [
      "ALTER TABLE jobs ADD COLUMN client_id INTEGER REFERENCES clients(id)",
      "ALTER TABLE jobs ADD COLUMN parent_project_id INTEGER REFERENCES jobs(id)",
    ];
    for (const sql of newCols15) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    // Seed clients from existing unique client text values in jobs table
    const uniqueClients = db.prepare('SELECT DISTINCT client FROM jobs WHERE client IS NOT NULL AND client != ?').all('');
    const insertClient = db.prepare('INSERT INTO clients (company_name) VALUES (?)');
    for (const row of uniqueClients) {
      try { insertClient.run(row.client); } catch (e) { /* ignore dups */ }
    }

    // Backfill client_id on jobs from the newly created clients
    db.exec(`
      UPDATE jobs SET client_id = (
        SELECT c.id FROM clients c WHERE c.company_name = jobs.client
      ) WHERE client IS NOT NULL AND client != '' AND client_id IS NULL
    `);

    recordMigration.run(15, 'Client Register & Project Structure');
    console.log('Migration 15 complete.');
  }

  // =============================================
  // Migration 16: Task Types (daily/weekly/one-off)
  // =============================================
  if (!isMigrationApplied.get(16)) {
    console.log('Running migration 16: Task Types');

    const taskCols = [
      "ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'one_off'",
    ];
    for (const sql of taskCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(16, 'Task Types');
    console.log('Migration 16 complete.');
  }

  // =============================================
  // Migration 17: SMTP Email Configuration
  // =============================================
  if (!isMigrationApplied.get(17)) {
    console.log('Running migration 17: SMTP Email Configuration');

    const insertConfig = db.prepare(`
      INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
      VALUES (?, ?, ?, ?)
    `);

    insertConfig.run('smtp_host', '', 'string', 'SMTP server hostname (e.g. smtp.gmail.com)');
    insertConfig.run('smtp_port', '587', 'string', 'SMTP server port (587 for TLS, 465 for SSL)');
    insertConfig.run('smtp_user', '', 'string', 'SMTP username / email address');
    insertConfig.run('smtp_pass', '', 'string', 'SMTP password or app password');
    insertConfig.run('smtp_from', 'noreply@tstraffic.com.au', 'string', 'Default sender email address');

    recordMigration.run(17, 'SMTP Email Configuration');
    console.log('Migration 17 complete.');
  }

  // =============================================
  // Migration 18: Make tasks.job_id optional
  // =============================================
  if (!isMigrationApplied.get(18)) {
    console.log('Running migration 18: Make tasks.job_id optional');

    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(`
        CREATE TABLE tasks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
          division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          owner_id INTEGER REFERENCES users(id),
          due_date DATE NOT NULL,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
          priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
          task_type TEXT DEFAULT 'one_off',
          notes TEXT DEFAULT '',
          completed_date DATE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO tasks_new SELECT * FROM tasks;
        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
        CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      `);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (r) {}
      console.log('Migration 18 skipped:', e.message);
    }

    recordMigration.run(18, 'Make tasks.job_id optional');
    console.log('Migration 18 complete.');
  }

  // =============================================
  // Migration 19: Fix tasks.job_id to allow NULL (explicit columns)
  // =============================================
  if (!isMigrationApplied.get(19)) {
    console.log('Running migration 19: Fix tasks.job_id nullable');

    // Check if job_id is already nullable
    const tableInfo = db.prepare("PRAGMA table_info(tasks)").all();
    const jobIdCol = tableInfo.find(c => c.name === 'job_id');
    if (jobIdCol && jobIdCol.notnull === 1) {
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER NOT NULL REFERENCES users(id),
            due_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            escalation_level INTEGER NOT NULL DEFAULT 0,
            completed_date DATE,
            notes TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            task_type TEXT DEFAULT 'one_off'
          );
          INSERT INTO tasks_new (id, job_id, division, title, description, owner_id, due_date, status, priority, escalation_level, completed_date, notes, created_at, updated_at, task_type)
          SELECT id, job_id, division, title, description, owner_id, due_date, status, priority, escalation_level, completed_date, notes, created_at, updated_at, task_type FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
        `);
        db.exec('COMMIT');
        console.log('Migration 19: tasks.job_id is now nullable.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.log('Migration 19 error:', e.message);
      }
    } else {
      console.log('Migration 19: tasks.job_id already nullable, skipping DDL.');
    }

    recordMigration.run(19, 'Fix tasks.job_id nullable');
    console.log('Migration 19 complete.');
  }

  // Migration 20: Email Invitations & Preferences
  // =============================================
  if (!isMigrationApplied.get(20)) {
    console.log('Running migration 20: Email Invitations & Preferences');

    db.exec(`
      CREATE TABLE IF NOT EXISTS invitations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('admin_user', 'crew_member', 'password_reset', 'pin_reset')),
        target_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_by_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
      CREATE INDEX IF NOT EXISTS idx_invitations_target ON invitations(type, target_id);
    `);

    const emailCols = [
      "ALTER TABLE users ADD COLUMN email_notifications_enabled INTEGER DEFAULT 1",
      "ALTER TABLE users ADD COLUMN notification_frequency TEXT DEFAULT 'immediate'",
      "ALTER TABLE crew_members ADD COLUMN email_notifications_enabled INTEGER DEFAULT 1",
      "ALTER TABLE crew_members ADD COLUMN notification_frequency TEXT DEFAULT 'immediate'",
      "ALTER TABLE notifications ADD COLUMN email_sent_at DATETIME",
    ];
    for (const sql of emailCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }

    recordMigration.run(20, 'Email Invitations & Preferences');
    console.log('Migration 20 complete.');
  }

  // Migration 21: Add SPA to compliance item_type + assigned_to_id column
  // =============================================
  if (!isMigrationApplied.get(21)) {
    console.log('Running migration 21: Add SPA type + assigned_to_id to compliance');

    // Recreate compliance table to add 'spa' to item_type CHECK and assigned_to_id column
    try {
      db.exec(`
        CREATE TABLE compliance_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','other')),
          title TEXT NOT NULL,
          authority_approver TEXT DEFAULT '',
          internal_approver_id INTEGER REFERENCES users(id),
          assigned_to_id INTEGER REFERENCES users(id),
          due_date DATE,
          submitted_date DATE,
          approved_date DATE,
          expiry_date DATE,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO compliance_new (id, job_id, item_type, title, authority_approver, internal_approver_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at)
          SELECT id, job_id, item_type, title, authority_approver, internal_approver_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at FROM compliance;
        DROP TABLE compliance;
        ALTER TABLE compliance_new RENAME TO compliance;
        CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
        CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        CREATE INDEX IF NOT EXISTS idx_compliance_type ON compliance(item_type);
      `);
    } catch (e) {
      console.log('Migration 21 note:', e.message);
    }

    recordMigration.run(21, 'Add SPA type and assigned_to_id to compliance');
    console.log('Migration 21 complete.');
  }

  // =============================================
  // Migration 22: Allow compliance to link to client instead of requiring a project
  // =============================================
  if (!isMigrationApplied.get(22)) {
    console.log('Running migration 22: Make job_id nullable + add client_id to compliance');
    try {
      db.exec(`
        CREATE TABLE compliance_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
          client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
          item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','rol','insurance_certificate','public_liability','vehicle_registration','plant_inspection','staff_certification','spa','other')),
          title TEXT NOT NULL,
          authority_approver TEXT DEFAULT '',
          internal_approver_id INTEGER REFERENCES users(id),
          assigned_to_id INTEGER REFERENCES users(id),
          due_date DATE,
          submitted_date DATE,
          approved_date DATE,
          expiry_date DATE,
          status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO compliance_new (id, job_id, client_id, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at)
          SELECT id, job_id, NULL, item_type, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, created_at, updated_at FROM compliance;
        DROP TABLE compliance;
        ALTER TABLE compliance_new RENAME TO compliance;
        CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_client_id ON compliance(client_id);
        CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
        CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
        CREATE INDEX IF NOT EXISTS idx_compliance_type ON compliance(item_type);
      `);
    } catch (e) {
      console.log('Migration 22 note:', e.message);
    }
    recordMigration.run(22, 'Make job_id nullable and add client_id to compliance');
    console.log('Migration 22 complete.');
  }

  // Migration 23: Was a failed attempt to rename roles via UPDATE (CHECK constraint blocked it)
  if (!isMigrationApplied.get(23)) {
    recordMigration.run(23, 'Rename roles: management->admin, accounts->finance, remove marketing (no-op, see migration 24)');
  }

  // Migration 24: was recorded but failed — skip it
  if (!isMigrationApplied.get(24)) {
    recordMigration.run(24, 'Recreate users table (no-op, see migration 25)');
  }

  // Migration 25: Recreate users table with updated role CHECK constraint
  // Must disable foreign keys to allow DROP TABLE
  if (!isMigrationApplied.get(25)) {
    console.log('Running migration 25: Recreate users table with new role CHECK');

    try {
      // Disable foreign keys so we can drop the users table
      db.pragma('foreign_keys = OFF');

      // Get column info to handle both old and new schemas
      const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const hasEmailNotif = cols.includes('email_notifications_enabled');
      const hasNotifFreq = cols.includes('notification_frequency');

      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          full_name TEXT NOT NULL,
          email TEXT,
          role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          email_notifications_enabled INTEGER DEFAULT 1,
          notification_frequency TEXT DEFAULT 'immediate'
        );
      `);

      db.exec(`
        INSERT INTO users_new (id, username, password_hash, full_name, email, role, active, created_at, email_notifications_enabled, notification_frequency)
        SELECT id, username, password_hash, full_name, email,
          CASE role
            WHEN 'management' THEN 'admin'
            WHEN 'accounts' THEN 'finance'
            WHEN 'marketing' THEN 'operations'
            ELSE role
          END,
          active, created_at,
          ${hasEmailNotif ? 'COALESCE(email_notifications_enabled, 1)' : '1'},
          ${hasNotifFreq ? "COALESCE(notification_frequency, 'immediate')" : "'immediate'"}
        FROM users;
      `);

      db.exec('DROP TABLE users;');
      db.exec('ALTER TABLE users_new RENAME TO users;');

      // Re-enable foreign keys
      db.pragma('foreign_keys = ON');

      // Also update tasks divisions
      try { db.prepare("UPDATE tasks SET division = 'admin' WHERE division = 'management'").run(); } catch (e) { /* ignore */ }
      try { db.prepare("UPDATE tasks SET division = 'finance' WHERE division = 'accounts'").run(); } catch (e) { /* ignore */ }
      try { db.prepare("UPDATE tasks SET division = 'ops' WHERE division = 'marketing'").run(); } catch (e) { /* ignore */ }

      recordMigration.run(25, 'Recreate users table with new role CHECK constraint');
      console.log('Migration 25 complete.');
    } catch (e) {
      db.pragma('foreign_keys = ON');
      // Clean up if users_new was created but not renamed
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch (re) { /* ignore */ }
      console.error('Migration 25 FAILED:', e.message);
    }
  }

  if (!isMigrationApplied.get(26)) {
    console.log('Running migration 26: Add designer, file_link, council fee fields to compliance');
    const newCols = [
      "ALTER TABLE compliance ADD COLUMN designer TEXT DEFAULT ''",
      "ALTER TABLE compliance ADD COLUMN file_link TEXT DEFAULT ''",
      "ALTER TABLE compliance ADD COLUMN council_fee_paid INTEGER DEFAULT 0",
      "ALTER TABLE compliance ADD COLUMN council_fee_amount REAL DEFAULT 0",
    ];
    for (const sql of newCols) {
      try { db.exec(sql); } catch (e) { /* column likely already exists */ }
    }
    recordMigration.run(26, 'Add designer, file_link, council fee fields to compliance');
    console.log('Migration 26 complete.');
  }

  // =============================================
  // Migration 27: Fix tasks division CHECK constraint
  // =============================================
  if (!isMigrationApplied.get(27)) {
    console.log('Running migration 27: Fix tasks division CHECK constraint');

    // Check current CHECK constraint by inspecting table SQL
    const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const needsFix = tableSQL && !tableSQL.sql.includes("'finance'");

    if (needsFix) {
      // Get current columns to build explicit INSERT
      const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      const colList = cols.join(', ');

      db.exec('BEGIN TRANSACTION');
      try {
        db.exec(`
          CREATE TABLE tasks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            owner_id INTEGER REFERENCES users(id),
            due_date DATE NOT NULL,
            status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
            priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
            task_type TEXT DEFAULT 'one_off',
            notes TEXT DEFAULT '',
            completed_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO tasks_new (${colList}) SELECT ${colList} FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
          CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
        `);
        db.exec('COMMIT');
        console.log('Migration 27: tasks table rebuilt with updated CHECK constraint.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.error('Migration 27 error:', e.message);
      }
    } else {
      console.log('Migration 27: CHECK constraint already correct, skipping rebuild.');
    }

    recordMigration.run(27, 'Fix tasks division CHECK constraint');
    console.log('Migration 27 complete.');
  }

  console.log('All migrations checked/applied.');
}

function initializeDatabase() {
  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance','management','marketing','accounts')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_number TEXT UNIQUE NOT NULL,
      job_name TEXT NOT NULL,
      client TEXT NOT NULL,
      site_address TEXT NOT NULL,
      suburb TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'lead' CHECK(status IN ('lead','won','active','on_hold','completed','lost')),
      stage TEXT NOT NULL DEFAULT 'tender' CHECK(stage IN ('tender','prestart','delivery','closeout')),
      percent_complete INTEGER NOT NULL DEFAULT 0 CHECK(percent_complete >= 0 AND percent_complete <= 100),
      start_date DATE NOT NULL,
      end_date DATE,
      project_manager_id INTEGER REFERENCES users(id),
      ops_supervisor_id INTEGER REFERENCES users(id),
      planning_owner_id INTEGER REFERENCES users(id),
      marketing_owner_id INTEGER REFERENCES users(id),
      accounts_owner_id INTEGER REFERENCES users(id),
      health TEXT NOT NULL DEFAULT 'green' CHECK(health IN ('green','amber','red')),
      accounts_status TEXT NOT NULL DEFAULT 'na' CHECK(accounts_status IN ('na','on_track','overdue','disputed')),
      division_tags TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      last_update_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      week_ending DATE NOT NULL,
      summary TEXT NOT NULL,
      milestones TEXT DEFAULT '',
      issues_risks TEXT DEFAULT '',
      blockers TEXT DEFAULT '',
      submitted_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      division TEXT NOT NULL CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','blocked','complete')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      escalation_level INTEGER NOT NULL DEFAULT 0,
      completed_date DATE,
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS compliance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('tmp_approval','council_permit','traffic_guidance','insurance','swms_review','induction','road_occupancy','utility_clearance','environmental','other')),
      title TEXT NOT NULL,
      authority_approver TEXT DEFAULT '',
      internal_approver_id INTEGER REFERENCES users(id),
      due_date DATE NOT NULL,
      submitted_date DATE,
      approved_date DATE,
      expiry_date DATE,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','submitted','approved','rejected','expired')),
      document_path TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      library TEXT NOT NULL CHECK(library IN ('delivery','accounts')),
      category TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- TIER-ONE ENHANCEMENT TABLES
    -- ============================================

    -- Activity Log / Audit Trail
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('create','update','delete','login','logout','upload','download','complete','approve','reject')),
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      entity_label TEXT DEFAULT '',
      job_id INTEGER REFERENCES jobs(id),
      job_number TEXT DEFAULT '',
      details TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Safety & Incident Reporting
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      incident_number TEXT UNIQUE NOT NULL,
      incident_type TEXT NOT NULL CHECK(incident_type IN ('injury','near_miss','hazard','property_damage','environmental','vehicle','other')),
      severity TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high','critical')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT DEFAULT '',
      incident_date DATE NOT NULL,
      incident_time TEXT DEFAULT '',
      reported_by_id INTEGER NOT NULL REFERENCES users(id),
      persons_involved TEXT DEFAULT '',
      witnesses TEXT DEFAULT '',
      immediate_actions TEXT DEFAULT '',
      root_cause TEXT DEFAULT '',
      investigation_status TEXT NOT NULL DEFAULT 'reported' CHECK(investigation_status IN ('reported','investigating','resolved','closed')),
      notifiable_incident INTEGER NOT NULL DEFAULT 0,
      photo_path TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS corrective_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      assigned_to_id INTEGER REFERENCES users(id),
      due_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','overdue','cancelled')),
      completed_date DATE,
      completion_notes TEXT DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Crew Members & Timesheets
    CREATE TABLE IF NOT EXISTS crew_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      employee_id TEXT UNIQUE,
      role TEXT NOT NULL DEFAULT 'traffic_controller' CHECK(role IN ('traffic_controller','leading_hand','supervisor','pilot_vehicle','spotter','labourer','other')),
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      licence_type TEXT DEFAULT '',
      licence_expiry DATE,
      induction_date DATE,
      active INTEGER NOT NULL DEFAULT 1,
      hourly_rate REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS timesheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
      work_date DATE NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      break_minutes INTEGER NOT NULL DEFAULT 30,
      total_hours REAL NOT NULL DEFAULT 0,
      shift_type TEXT NOT NULL DEFAULT 'day' CHECK(shift_type IN ('day','night','split')),
      role_on_site TEXT DEFAULT '',
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by_id INTEGER REFERENCES users(id),
      approved_at DATETIME,
      notes TEXT DEFAULT '',
      submitted_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Budget & Cost Tracking
    CREATE TABLE IF NOT EXISTS job_budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      contract_value REAL NOT NULL DEFAULT 0,
      budget_labour REAL NOT NULL DEFAULT 0,
      budget_materials REAL NOT NULL DEFAULT 0,
      budget_subcontractors REAL NOT NULL DEFAULT 0,
      budget_equipment REAL NOT NULL DEFAULT 0,
      budget_other REAL NOT NULL DEFAULT 0,
      variations_approved REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      updated_by_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      budget_id INTEGER NOT NULL REFERENCES job_budgets(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK(category IN ('labour','materials','subcontractors','equipment','other')),
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      entry_date DATE NOT NULL,
      invoice_ref TEXT DEFAULT '',
      supplier TEXT DEFAULT '',
      entered_by_id INTEGER NOT NULL REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Client Contacts & Communication Log
    CREATE TABLE IF NOT EXISTS client_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
      contact_type TEXT NOT NULL CHECK(contact_type IN ('client','council','utility','rms','subcontractor','consultant','other')),
      company TEXT NOT NULL,
      full_name TEXT NOT NULL,
      position TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS communication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES client_contacts(id) ON DELETE SET NULL,
      comm_type TEXT NOT NULL CHECK(comm_type IN ('phone','email','meeting','site_visit','letter','other')),
      direction TEXT NOT NULL DEFAULT 'outgoing' CHECK(direction IN ('incoming','outgoing')),
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      follow_up_required INTEGER NOT NULL DEFAULT 0,
      follow_up_date DATE,
      follow_up_done INTEGER NOT NULL DEFAULT 0,
      logged_by_id INTEGER NOT NULL REFERENCES users(id),
      comm_date DATE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Equipment & Asset Register
    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_number TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('barrier','sign','arrow_board','vms','vehicle','lighting','cone','delineator','other')),
      description TEXT DEFAULT '',
      serial_number TEXT DEFAULT '',
      purchase_date DATE,
      purchase_cost REAL DEFAULT 0,
      current_condition TEXT NOT NULL DEFAULT 'good' CHECK(current_condition IN ('new','good','fair','poor','damaged','decommissioned')),
      storage_location TEXT DEFAULT '',
      next_inspection_date DATE,
      inspection_interval_days INTEGER DEFAULT 90,
      notes TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      assigned_date DATE NOT NULL,
      expected_return_date DATE,
      actual_return_date DATE,
      quantity INTEGER NOT NULL DEFAULT 1,
      assigned_by_id INTEGER NOT NULL REFERENCES users(id),
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS equipment_maintenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      maintenance_type TEXT NOT NULL CHECK(maintenance_type IN ('inspection','repair','service','calibration','replacement')),
      description TEXT NOT NULL,
      performed_date DATE NOT NULL,
      performed_by TEXT DEFAULT '',
      cost REAL DEFAULT 0,
      next_due_date DATE,
      result TEXT NOT NULL DEFAULT 'pass' CHECK(result IN ('pass','fail','conditional')),
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Defects & Snag List
    CREATE TABLE IF NOT EXISTS defects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      defect_number TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      location TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'minor' CHECK(severity IN ('minor','moderate','major','critical')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','rectification','closed','deferred')),
      reported_by_id INTEGER NOT NULL REFERENCES users(id),
      assigned_to_id INTEGER REFERENCES users(id),
      reported_date DATE NOT NULL,
      target_close_date DATE,
      actual_close_date DATE,
      photo_path TEXT DEFAULT '',
      rectification_notes TEXT DEFAULT '',
      linked_compliance_id INTEGER REFERENCES compliance(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','new_incident','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','timesheet_approval','budget_alert','general')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT DEFAULT '',
      job_id INTEGER REFERENCES jobs(id),
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes for performance (original)
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);
    CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client);
    CREATE INDEX IF NOT EXISTS idx_jobs_suburb ON jobs(suburb);
    CREATE INDEX IF NOT EXISTS idx_jobs_health ON jobs(health);
    CREATE INDEX IF NOT EXISTS idx_jobs_pm ON jobs(project_manager_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_start_date ON jobs(start_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_job_id ON tasks(job_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_compliance_job_id ON compliance(job_id);
    CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance(status);
    CREATE INDEX IF NOT EXISTS idx_compliance_due_date ON compliance(due_date);
    CREATE INDEX IF NOT EXISTS idx_updates_job_id ON project_updates(job_id);
    CREATE INDEX IF NOT EXISTS idx_updates_week ON project_updates(week_ending);
    CREATE INDEX IF NOT EXISTS idx_documents_job_id ON documents(job_id);
    CREATE INDEX IF NOT EXISTS idx_documents_library ON documents(library);

    -- New indexes for tier-one tables
    CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON activity_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_job ON activity_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_incidents_job ON incidents(job_id);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(investigation_status);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_date ON incidents(incident_date);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_incident ON corrective_actions(incident_id);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_status ON corrective_actions(status);
    CREATE INDEX IF NOT EXISTS idx_corrective_actions_due ON corrective_actions(due_date);
    CREATE INDEX IF NOT EXISTS idx_crew_members_active ON crew_members(active);
    CREATE INDEX IF NOT EXISTS idx_timesheets_job ON timesheets(job_id);
    CREATE INDEX IF NOT EXISTS idx_timesheets_crew ON timesheets(crew_member_id);
    CREATE INDEX IF NOT EXISTS idx_timesheets_date ON timesheets(work_date);
    CREATE INDEX IF NOT EXISTS idx_timesheets_approved ON timesheets(approved);
    CREATE INDEX IF NOT EXISTS idx_job_budgets_job ON job_budgets(job_id);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_job ON cost_entries(job_id);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_category ON cost_entries(category);
    CREATE INDEX IF NOT EXISTS idx_client_contacts_job ON client_contacts(job_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_job ON communication_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_contact ON communication_log(contact_id);
    CREATE INDEX IF NOT EXISTS idx_communication_log_followup ON communication_log(follow_up_required, follow_up_done);
    CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category);
    CREATE INDEX IF NOT EXISTS idx_equipment_active ON equipment(active);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_equip ON equipment_assignments(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_assignments_job ON equipment_assignments(job_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_equip ON equipment_maintenance(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_defects_job ON defects(job_id);
    CREATE INDEX IF NOT EXISTS idx_defects_status ON defects(status);
    CREATE INDEX IF NOT EXISTS idx_defects_severity ON defects(severity);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, is_read);
    CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
  `);

  // Run migrations to add new columns, expand CHECK constraints, and create new tables
  runMigrations(db);

  // Seed default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync('admin123', 12);
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?, ?, ?, ?, ?)
    `);

    insertUser.run('admin', hash, 'Admin User', 'admin@tstraffic.com.au', 'admin');
    insertUser.run('ops_user', bcrypt.hashSync('password', 12), 'Sam Operations', 'sam@tstraffic.com.au', 'operations');
    insertUser.run('planning_user', bcrypt.hashSync('password', 12), 'Alex Planning', 'alex@tstraffic.com.au', 'planning');
    insertUser.run('finance_user', bcrypt.hashSync('password', 12), 'Pat Finance', 'pat@tstraffic.com.au', 'finance');

    // Seed sample jobs (use statuses valid under the new CHECK after migration 1 runs)
    const insertJob = db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status, last_update_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertJob.run('J-02451', 'J-02451 | ABC Civil | Bankstown | 2026-02-15', 'ABC Civil', '12 Canterbury Rd', 'Bankstown', 'active', 'delivery', 45, '2026-02-15', '2026-06-30', 1, 2, 3, 4, 5, 'green', 'on_track', '2026-02-25');
    insertJob.run('J-02452', 'J-02452 | RMS NSW | Parramatta | 2026-03-01', 'RMS NSW', '88 Church St', 'Parramatta', 'active', 'prestart', 10, '2026-03-01', '2026-09-15', 1, 2, 3, 4, 5, 'amber', 'na', null);
    insertJob.run('J-02453', 'J-02453 | Lendlease | Chatswood | 2026-03-10', 'Lendlease', '1 Help St', 'Chatswood', 'won', 'tender', 0, '2026-03-10', '2026-12-01', 1, 2, 3, 4, 5, 'green', 'na', null);
    insertJob.run('J-02454', 'J-02454 | Sydney Water | Liverpool | 2026-01-10', 'Sydney Water', '45 Macquarie St', 'Liverpool', 'active', 'delivery', 80, '2026-01-10', '2026-04-15', 1, 2, 3, 4, 5, 'red', 'overdue', '2026-02-10');
    insertJob.run('J-02455', 'J-02455 | Ausgrid | Penrith | 2026-02-01', 'Ausgrid', '22 Henry St', 'Penrith', 'on_hold', 'delivery', 35, '2026-02-01', '2026-07-30', 1, 2, 3, 4, 5, 'amber', 'disputed', '2026-02-20');

    // Seed sample tasks
    const insertTask = db.prepare(`
      INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTask.run(1, 'ops', 'Install traffic barriers Section A', 'Complete barrier installation on Canterbury Rd northbound', 2, '2026-02-28', 'in_progress', 'high');
    insertTask.run(1, 'planning', 'Submit TMP revision to council', 'Updated TMP with night works clause', 3, '2026-02-20', 'not_started', 'high');
    insertTask.run(2, 'planning', 'Complete traffic guidance scheme', 'Full TGS for Church St closure', 3, '2026-03-05', 'in_progress', 'medium');
    insertTask.run(4, 'ops', 'Final inspection walkthrough', 'Arrange RMS site inspection', 2, '2026-02-25', 'not_started', 'high');
    insertTask.run(4, 'accounts', 'Chase overdue invoice #INV-4421', 'Invoice 60 days overdue', 5, '2026-02-15', 'not_started', 'high');

    // Seed sample compliance
    const insertCompliance = db.prepare(`
      INSERT INTO compliance (job_id, item_type, title, authority_approver, internal_approver_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertCompliance.run(1, 'tmp_approval', 'TMP Approval - Canterbury Rd', 'Canterbury-Bankstown Council', 3, '2026-02-20', 'approved');
    insertCompliance.run(1, 'swms_review', 'SWMS Review - Barrier Install', '', 2, '2026-02-27', 'submitted');
    insertCompliance.run(2, 'council_permit', 'Road Closure Permit - Church St', 'City of Parramatta Council', 3, '2026-03-08', 'not_started');
    insertCompliance.run(2, 'insurance', 'Public Liability Certificate', 'Insurer', 5, '2026-03-01', 'submitted');
    insertCompliance.run(4, 'road_occupancy', 'ROL Extension - Macquarie St', 'Transport for NSW', 3, '2026-02-18', 'not_started');

    // Seed sample updates
    const insertUpdate = db.prepare(`
      INSERT INTO project_updates (job_id, week_ending, summary, milestones, issues_risks, blockers, submitted_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertUpdate.run(1, '2026-02-28', 'Good progress on barrier installation. Section A 80% complete. Night works approved by council.', 'Section A barriers 80% installed. Council night works approval received.', 'Minor delay due to weather on Tuesday. Subcontractor availability next week uncertain.', '', 1);
    insertUpdate.run(4, '2026-02-14', 'Project nearing completion but facing payment issues. Final inspection scheduled for next week.', 'Pavement marking completed. Signage installed.', 'Client disputing variation claim. Invoice 60 days overdue.', 'Cannot proceed with demobilisation until payment received.', 1);

    console.log('Database seeded with sample data.');
  }

  db.close();
  console.log('Database initialized at', DB_PATH);
}

module.exports = { initializeDatabase, DB_PATH };
