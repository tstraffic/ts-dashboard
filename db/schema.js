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
            type TEXT NOT NULL CHECK(type IN ('overdue_task','expiring_compliance','missing_update','corrective_action_due','follow_up_due','equipment_overdue','critical_defect','rol_pending','ticket_expiry','equipment_inspection_due','induction_overdue','over_budget','deadline_reminder','general')),
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

  // =============================================
  // Migration 28: Force-fix tasks division CHECK constraint (retry-safe)
  // =============================================
  if (!isMigrationApplied.get(28)) {
    console.log('Running migration 28: Force-fix tasks division CHECK');

    const tableSQL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const currentSQL = tableSQL ? tableSQL.sql : '';
    console.log('[Migration 28] Current tasks DDL:', currentSQL);

    if (!currentSQL.includes("'finance'") || !currentSQL.includes("'admin'")) {
      // Get only column names that actually exist in current table
      const existingCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
      console.log('[Migration 28] Existing columns:', existingCols.join(', '));

      // Target columns for new table
      const targetCols = ['id','job_id','division','title','description','owner_id','due_date','status','priority','task_type','notes','completed_date','created_at','updated_at'];
      // Only copy columns present in BOTH old and new
      const commonCols = targetCols.filter(c => existingCols.includes(c));
      const colList = commonCols.join(', ');
      console.log('[Migration 28] Copying columns:', colList);

      try {
        db.exec('BEGIN TRANSACTION');
        db.exec(`
          CREATE TABLE tasks_rebuild (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
            division TEXT NOT NULL DEFAULT 'ops' CHECK(division IN ('ops','planning','finance','admin','marketing','accounts','management')),
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
          )
        `);
        db.exec(`INSERT INTO tasks_rebuild (${colList}) SELECT ${colList} FROM tasks`);
        db.exec('DROP TABLE tasks');
        db.exec('ALTER TABLE tasks_rebuild RENAME TO tasks');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
        db.exec('COMMIT');
        console.log('Migration 28: tasks table rebuilt successfully.');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (r) {}
        console.error('Migration 28 FAILED:', e.message, e.stack);
        // Do NOT record migration — allow retry on next restart
        throw new Error('Migration 28 failed: ' + e.message);
      }
    } else {
      console.log('Migration 28: CHECK constraint already includes finance/admin, skipping.');
    }

    recordMigration.run(28, 'Force-fix tasks division CHECK constraint');
    console.log('Migration 28 complete.');
  }

  // =============================================
  // Migration 29: Push notification subscriptions
  // =============================================
  if (!isMigrationApplied.get(29)) {
    console.log('Running migration 29: Push notification subscriptions table');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');
      recordMigration.run(29, 'Push notification subscriptions table');
      console.log('Migration 29 complete.');
    } catch (e) {
      console.error('Migration 29 error:', e.message);
    }
  }

  // Migration 30: Saved views + user preferences
  if (!isMigrationApplied.get(30)) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          module TEXT NOT NULL,
          name TEXT NOT NULL,
          query_params TEXT NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_saved_views_user ON saved_views(user_id, module)');
      // Add preferences column to users if not exists
      try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
      recordMigration.run(30, 'Saved views table + user preferences column');
      console.log('Migration 30 complete.');
    } catch (e) {
      console.error('Migration 30 error:', e.message);
    }
  }

  // =============================================
  // Migration 31: Task comments, subtasks, and dependencies
  // =============================================
  if (!isMigrationApplied.get(31)) {
    console.log('Running migration 31: Task comments, subtasks, and dependencies');
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_comments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          comment TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS subtasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          completed INTEGER DEFAULT 0,
          completed_at DATETIME,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(task_id, depends_on_id)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_task_deps_depends ON task_dependencies(depends_on_id)');
      recordMigration.run(31, 'Task comments, subtasks, and dependencies');
      console.log('Migration 31 complete.');
    } catch (e) {
      console.error('Migration 31 error:', e.message);
    }
  }

  // =============================================
  // Migration 32: Timesheet OT split
  // =============================================
  if (!isMigrationApplied.get(32)) {
    console.log('Running migration 32: Timesheet OT split');
    try {
      const hasOrdinaryHours = db.prepare("SELECT 1 FROM pragma_table_info('timesheets') WHERE name = 'ordinary_hours'").get();
      if (!hasOrdinaryHours) {
        db.exec(`
          ALTER TABLE timesheets ADD COLUMN ordinary_hours REAL DEFAULT 0;
        `);
        db.exec(`
          ALTER TABLE timesheets ADD COLUMN overtime_hours REAL DEFAULT 0;
        `);
        // Backfill: assume 7.6 hours is ordinary, rest is OT
        db.exec(`
          UPDATE timesheets SET
            ordinary_hours = CASE WHEN total_hours <= 7.6 THEN total_hours ELSE 7.6 END,
            overtime_hours = CASE WHEN total_hours > 7.6 THEN ROUND(total_hours - 7.6, 2) ELSE 0 END
        `);
      }
      recordMigration.run(32, 'Timesheet OT split');
      console.log('Migration 32 complete.');
    } catch (e) {
      console.error('Migration 32 error:', e.message);
    }
  }

  // =============================================
  // Migration 33: Equipment status states
  // =============================================
  if (!isMigrationApplied.get(33)) {
    console.log('Running migration 33: Equipment status states');
    try {
      const hasStatus = db.prepare("SELECT 1 FROM pragma_table_info('equipment') WHERE name = 'status'").get();
      if (!hasStatus) {
        db.exec(`ALTER TABLE equipment ADD COLUMN status TEXT DEFAULT 'available'`);
        // Backfill based on current state
        db.exec(`UPDATE equipment SET status = 'retired' WHERE active = 0`);
        db.exec(`UPDATE equipment SET status = 'deployed' WHERE id IN (SELECT equipment_id FROM equipment_assignments WHERE actual_return_date IS NULL) AND active = 1`);
        db.exec(`UPDATE equipment SET status = 'inspection_due' WHERE next_inspection_date IS NOT NULL AND next_inspection_date <= date('now', '+7 days') AND active = 1 AND status = 'available'`);
        db.exec(`UPDATE equipment SET status = 'maintenance' WHERE current_condition IN ('poor', 'damaged') AND active = 1 AND status = 'available'`);
      }
      recordMigration.run(33, 'Equipment status states');
      console.log('Migration 33 complete.');
    } catch (e) {
      console.error('Migration 33 error:', e.message);
    }
  }

  // =============================================
  // Migration 34: Incident escalation + photo columns
  // =============================================
  if (!isMigrationApplied.get(34)) {
    console.log('Running migration 34: Incident escalation columns');
    try {
      const hasEscalation = db.prepare("SELECT 1 FROM pragma_table_info('incidents') WHERE name = 'escalation_level'").get();
      if (!hasEscalation) {
        db.exec(`ALTER TABLE incidents ADD COLUMN escalation_level TEXT DEFAULT 'standard'`);
        db.exec(`ALTER TABLE incidents ADD COLUMN escalated_at DATETIME`);
        db.exec(`ALTER TABLE incidents ADD COLUMN escalated_by_id INTEGER REFERENCES users(id)`);
        // Backfill: escalate based on severity and notifiable status
        db.exec(`UPDATE incidents SET escalation_level = 'elevated' WHERE severity = 'high'`);
        db.exec(`UPDATE incidents SET escalation_level = 'critical' WHERE severity = 'critical'`);
        db.exec(`UPDATE incidents SET escalation_level = 'regulator' WHERE notifiable_incident = 1`);
      }
      recordMigration.run(34, 'Incident escalation columns');
      console.log('Migration 34 complete.');
    } catch (e) {
      console.error('Migration 34 error:', e.message);
    }
  }

  // =============================================
  // Migration 35: Company Directory — add company_type + type-specific fields to clients, company_id to client_contacts
  // =============================================
  if (!isMigrationApplied.get(35)) {
    console.log('Running migration 35: Company Directory — company_type + type-specific fields');
    try {
      const newCols = [
        "ALTER TABLE clients ADD COLUMN company_type TEXT NOT NULL DEFAULT 'client'",
        "ALTER TABLE clients ADD COLUMN trade_specialty TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN insurance_expiry DATE",
        "ALTER TABLE clients ADD COLUMN insurance_policy TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN product_categories TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN account_number TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN website TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN approved INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE clients ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE client_contacts ADD COLUMN company_id INTEGER REFERENCES clients(id) ON DELETE SET NULL",
      ];
      for (const sql of newCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }
      // Indexes
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_company_type ON clients(company_type)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_client_contacts_company ON client_contacts(company_id)'); } catch (e) {}

      recordMigration.run(35, 'Company Directory — company_type, type-specific fields, company_id on contacts');
      console.log('Migration 35 complete.');
    } catch (e) {
      console.error('Migration 35 error:', e.message);
    }
  }

  // =============================================
  // Migration 36: CRM / BDM Module
  // =============================================
  if (!isMigrationApplied.get(36)) {
    console.log('Running migration 36: CRM / BDM Module — opportunities, activities, account enhancements');
    try {
      // A. New CRM columns on clients table
      const crmClientCols = [
        "ALTER TABLE clients ADD COLUMN account_status TEXT DEFAULT 'active'",
        "ALTER TABLE clients ADD COLUMN account_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE clients ADD COLUMN bdm_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE clients ADD COLUMN lead_source TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN estimated_annual_value REAL DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN last_contacted_date DATE",
        "ALTER TABLE clients ADD COLUMN next_action_date DATE",
        "ALTER TABLE clients ADD COLUMN next_action_note TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN service_interests TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN target_regions TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN priority TEXT DEFAULT 'normal'",
        "ALTER TABLE clients ADD COLUMN prequal_status TEXT DEFAULT 'none'",
        "ALTER TABLE clients ADD COLUMN vendor_status TEXT DEFAULT 'none'",
        "ALTER TABLE clients ADD COLUMN contract_status TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN industry_segment TEXT DEFAULT ''",
      ];
      for (const sql of crmClientCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // B. New CRM columns on client_contacts table
      const crmContactCols = [
        "ALTER TABLE client_contacts ADD COLUMN relationship_strength TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN influence_level TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN buying_role TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN preferred_comm_method TEXT DEFAULT ''",
        "ALTER TABLE client_contacts ADD COLUMN last_contact_date DATE",
        "ALTER TABLE client_contacts ADD COLUMN next_contact_date DATE",
        "ALTER TABLE client_contacts ADD COLUMN contact_owner_id INTEGER REFERENCES users(id)",
        "ALTER TABLE client_contacts ADD COLUMN referred_by TEXT DEFAULT ''",
      ];
      for (const sql of crmContactCols) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // C. Opportunities table
      db.exec(`
        CREATE TABLE IF NOT EXISTS opportunities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opportunity_number TEXT UNIQUE,
          title TEXT NOT NULL,
          client_id INTEGER REFERENCES clients(id),
          contact_id INTEGER REFERENCES client_contacts(id),
          owner_id INTEGER REFERENCES users(id),
          service_type TEXT DEFAULT '',
          stage TEXT DEFAULT 'new_lead',
          probability INTEGER DEFAULT 10,
          estimated_value REAL DEFAULT 0,
          weighted_value REAL DEFAULT 0,
          expected_close_date DATE,
          source TEXT DEFAULT '',
          region TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          next_step TEXT DEFAULT '',
          next_step_due_date DATE,
          status TEXT DEFAULT 'open' CHECK(status IN ('open','won','lost','on_hold')),
          loss_reason TEXT DEFAULT '',
          related_job_id INTEGER REFERENCES jobs(id),
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_client ON opportunities(client_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_owner ON opportunities(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_stage ON opportunities(stage)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_opportunities_close_date ON opportunities(expected_close_date)'); } catch (e) {}

      // D. CRM Activities table
      db.exec(`
        CREATE TABLE IF NOT EXISTS crm_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_type TEXT NOT NULL,
          subject TEXT NOT NULL,
          notes TEXT DEFAULT '',
          outcome TEXT DEFAULT '',
          client_id INTEGER REFERENCES clients(id),
          contact_id INTEGER REFERENCES client_contacts(id),
          opportunity_id INTEGER REFERENCES opportunities(id),
          job_id INTEGER REFERENCES jobs(id),
          owner_id INTEGER REFERENCES users(id),
          activity_date DATETIME,
          next_step TEXT DEFAULT '',
          next_step_due_date DATE,
          location TEXT DEFAULT '',
          is_completed INTEGER DEFAULT 0,
          reminder INTEGER DEFAULT 0,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_client ON crm_activities(client_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_opportunity ON crm_activities(opportunity_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_owner ON crm_activities(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_activities_date ON crm_activities(activity_date)'); } catch (e) {}

      // E. Seed CRM settings
      const seedSetting = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, color, display_order, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      const crmSeeds = {
        opportunity_stages: [
          { key: 'new_lead', label: 'New Lead', color: 'sky' },
          { key: 'qualified', label: 'Qualified', color: 'blue' },
          { key: 'contacted', label: 'Contacted', color: 'indigo' },
          { key: 'meeting_booked', label: 'Meeting Booked', color: 'purple' },
          { key: 'proposal_pending', label: 'Proposal Pending', color: 'amber' },
          { key: 'quote_sent', label: 'Quote Sent', color: 'orange' },
          { key: 'negotiation', label: 'Negotiation', color: 'red' },
          { key: 'awaiting_decision', label: 'Awaiting Decision', color: 'pink' },
          { key: 'won', label: 'Won', color: 'emerald' },
          { key: 'lost', label: 'Lost', color: 'gray' },
          { key: 'on_hold', label: 'On Hold', color: 'slate' },
        ],
        crm_activity_types: [
          { key: 'call', label: 'Call', color: 'blue' },
          { key: 'email', label: 'Email', color: 'sky' },
          { key: 'meeting', label: 'Meeting', color: 'purple' },
          { key: 'site_visit', label: 'Site Visit', color: 'emerald' },
          { key: 'proposal_sent', label: 'Proposal Sent', color: 'amber' },
          { key: 'follow_up', label: 'Follow Up', color: 'orange' },
          { key: 'tender_submitted', label: 'Tender Submitted', color: 'indigo' },
          { key: 'onboarding', label: 'Onboarding', color: 'teal' },
          { key: 'intro_networking', label: 'Intro / Networking', color: 'pink' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        lead_sources: [
          { key: 'inbound', label: 'Inbound', color: 'blue' },
          { key: 'outbound', label: 'Outbound', color: 'purple' },
          { key: 'referral', label: 'Referral', color: 'emerald' },
          { key: 'website', label: 'Website', color: 'sky' },
          { key: 'tender_portal', label: 'Tender Portal', color: 'amber' },
          { key: 'networking', label: 'Networking', color: 'pink' },
          { key: 'existing_client', label: 'Existing Client', color: 'teal' },
          { key: 'cold_call', label: 'Cold Call', color: 'orange' },
          { key: 'event', label: 'Event', color: 'indigo' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        loss_reasons: [
          { key: 'price', label: 'Price', color: 'red' },
          { key: 'timing', label: 'Timing', color: 'amber' },
          { key: 'competitor', label: 'Competitor', color: 'orange' },
          { key: 'no_budget', label: 'No Budget', color: 'gray' },
          { key: 'no_response', label: 'No Response', color: 'slate' },
          { key: 'scope', label: 'Scope Mismatch', color: 'purple' },
          { key: 'relationship', label: 'Relationship', color: 'pink' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        service_categories: [
          { key: 'traffic_control', label: 'Traffic Control', color: 'blue' },
          { key: 'traffic_plans', label: 'Traffic Plans', color: 'indigo' },
          { key: 'rol_permits', label: 'ROL / Permits', color: 'purple' },
          { key: 'equipment_hire', label: 'Equipment Hire', color: 'amber' },
          { key: 'events', label: 'Events', color: 'pink' },
          { key: 'shutdown_emergency', label: 'Shutdown / Emergency', color: 'red' },
          { key: 'civil_support', label: 'Civil Support', color: 'emerald' },
        ],
        priority_levels: [
          { key: 'low', label: 'Low', color: 'gray' },
          { key: 'normal', label: 'Normal', color: 'blue' },
          { key: 'high', label: 'High', color: 'amber' },
          { key: 'strategic', label: 'Strategic', color: 'purple' },
        ],
      };

      for (const [category, items] of Object.entries(crmSeeds)) {
        items.forEach((item, idx) => {
          seedSetting.run(category, item.key, item.label, item.color || '', idx);
        });
      }

      // Client CRM indexes
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_account_owner ON clients(account_owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_bdm_owner ON clients(bdm_owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_clients_next_action ON clients(next_action_date)'); } catch (e) {}

      recordMigration.run(36, 'CRM / BDM Module — opportunities, activities, account enhancements');
      console.log('Migration 36 complete.');
    } catch (e) {
      console.error('Migration 36 error:', e.message);
    }
  }

  // =============================================
  // Migration 37: CRM Sprint 2 — meetings, missing fields, settings
  // =============================================
  if (!isMigrationApplied.get(37)) {
    console.log('Running migration 37: CRM Sprint 2 — meetings, missing fields, settings');
    try {
      // A. New columns on clients
      const clientCols37 = [
        "ALTER TABLE clients ADD COLUMN phone TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN email_general TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN suburb TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN state TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN postcode TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN client_category TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN onboarding_stage TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN tender_panel_status TEXT DEFAULT ''",
      ];
      for (const sql of clientCols37) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // B. Remove CHECK constraint on client_contacts.contact_type by recreating table
      // SQLite does not support ALTER TABLE DROP CONSTRAINT, so we must recreate
      try {
        const hasCheck = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='client_contacts'").get();
        if (hasCheck && hasCheck.sql && hasCheck.sql.includes("CHECK(contact_type IN")) {
          db.exec(`
            CREATE TABLE client_contacts_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
              company_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
              contact_type TEXT NOT NULL DEFAULT 'other',
              company TEXT NOT NULL DEFAULT '',
              full_name TEXT NOT NULL DEFAULT '',
              position TEXT DEFAULT '',
              phone TEXT DEFAULT '',
              email TEXT DEFAULT '',
              notes TEXT DEFAULT '',
              is_primary INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              relationship_strength TEXT DEFAULT '',
              influence_level TEXT DEFAULT '',
              buying_role TEXT DEFAULT '',
              preferred_comm_method TEXT DEFAULT '',
              referred_by TEXT DEFAULT '',
              contact_owner_id INTEGER REFERENCES users(id),
              last_contact_date DATE,
              next_contact_date DATE,
              first_name TEXT DEFAULT '',
              last_name TEXT DEFAULT '',
              mobile TEXT DEFAULT '',
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          // Copy existing data
          const existingCols = db.pragma('table_info(client_contacts)').map(c => c.name);
          const commonCols = existingCols.filter(c =>
            ['id','job_id','company_id','contact_type','company','full_name','position','phone','email',
             'notes','is_primary','created_at','relationship_strength','influence_level','buying_role',
             'preferred_comm_method','referred_by','contact_owner_id','last_contact_date','next_contact_date',
             'first_name','last_name','mobile','updated_at'].includes(c)
          );
          const colList = commonCols.join(', ');
          db.exec(`INSERT INTO client_contacts_new (${colList}) SELECT ${colList} FROM client_contacts`);
          db.exec('DROP TABLE client_contacts');
          db.exec('ALTER TABLE client_contacts_new RENAME TO client_contacts');
          console.log('  Recreated client_contacts without CHECK constraint');
        }
      } catch (e) {
        console.warn('  Could not recreate client_contacts:', e.message);
        // Fallback: just add new columns
        const contactCols37 = [
          "ALTER TABLE client_contacts ADD COLUMN first_name TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN last_name TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN mobile TEXT DEFAULT ''",
          "ALTER TABLE client_contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        ];
        for (const sql of contactCols37) {
          try { db.exec(sql); } catch (e2) { /* column likely already exists */ }
        }
      }

      // C. New columns on opportunities
      const oppCols37 = [
        "ALTER TABLE opportunities ADD COLUMN won_date DATE",
        "ALTER TABLE opportunities ADD COLUMN lost_date DATE",
        "ALTER TABLE opportunities ADD COLUMN last_activity_at DATETIME",
      ];
      for (const sql of oppCols37) {
        try { db.exec(sql); } catch (e) { /* column likely already exists */ }
      }

      // D. New column on crm_activities
      try { db.exec("ALTER TABLE crm_activities ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (e) {}

      // E. crm_meetings table
      db.exec(`
        CREATE TABLE IF NOT EXISTS crm_meetings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          activity_id INTEGER REFERENCES crm_activities(id) ON DELETE SET NULL,
          account_id INTEGER REFERENCES clients(id),
          opportunity_id INTEGER REFERENCES opportunities(id),
          owner_id INTEGER REFERENCES users(id),
          title TEXT NOT NULL,
          meeting_date DATETIME NOT NULL,
          duration_minutes INTEGER,
          location_type TEXT DEFAULT '',
          location_text TEXT DEFAULT '',
          attendees TEXT DEFAULT '',
          purpose TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          outcome TEXT DEFAULT '',
          follow_up_actions TEXT DEFAULT '',
          next_meeting_date DATE,
          created_by_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Indexes on crm_meetings
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_account ON crm_meetings(account_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_opportunity ON crm_meetings(opportunity_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_owner ON crm_meetings(owner_id)'); } catch (e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_crm_meetings_date ON crm_meetings(meeting_date)'); } catch (e) {}

      // F. Seed new settings categories
      const seedSetting37 = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, color, display_order, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      const newSeeds = {
        industry_segments: [
          { key: 'civil', label: 'Civil', color: 'blue' },
          { key: 'utilities', label: 'Utilities', color: 'amber' },
          { key: 'government', label: 'Government', color: 'indigo' },
          { key: 'council', label: 'Council', color: 'teal' },
          { key: 'events', label: 'Events', color: 'pink' },
          { key: 'commercial_builder', label: 'Commercial Builder', color: 'orange' },
          { key: 'rail', label: 'Rail', color: 'purple' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
        client_categories: [
          { key: 'principal_contractor', label: 'Principal Contractor', color: 'blue' },
          { key: 'subcontractor', label: 'Subcontractor', color: 'amber' },
          { key: 'builder', label: 'Builder', color: 'orange' },
          { key: 'utility', label: 'Utility', color: 'teal' },
          { key: 'council', label: 'Council', color: 'indigo' },
          { key: 'event_organiser', label: 'Event Organiser', color: 'pink' },
          { key: 'government', label: 'Government', color: 'purple' },
          { key: 'private_client', label: 'Private Client', color: 'emerald' },
        ],
        contact_types: [
          { key: 'decision_maker', label: 'Decision Maker', color: 'red' },
          { key: 'project_manager', label: 'Project Manager', color: 'blue' },
          { key: 'estimator', label: 'Estimator', color: 'amber' },
          { key: 'procurement', label: 'Procurement', color: 'purple' },
          { key: 'safety', label: 'Safety', color: 'emerald' },
          { key: 'planner', label: 'Planner', color: 'indigo' },
          { key: 'accounts', label: 'Accounts', color: 'teal' },
          { key: 'site_contact', label: 'Site Contact', color: 'orange' },
          { key: 'other', label: 'Other', color: 'gray' },
        ],
      };

      for (const [category, items] of Object.entries(newSeeds)) {
        items.forEach((item, idx) => {
          seedSetting37.run(category, item.key, item.label, item.color || '', idx);
        });
      }

      recordMigration.run(37, 'CRM Sprint 2 — meetings table, missing fields, new settings');
      console.log('Migration 37 complete.');
    } catch (e) {
      console.error('Migration 37 error:', e.message);
    }
  }

  // =============================================
  // Migration 38: HR / People Ops Foundation
  // =============================================
  if (!isMigrationApplied.get(38)) {
    console.log('Running migration 38: HR / People Ops Foundation');
    try {
      // --- A. employees table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employees (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_code TEXT UNIQUE,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          full_name TEXT NOT NULL,
          preferred_name TEXT DEFAULT '',
          company TEXT DEFAULT '',
          division TEXT DEFAULT '',
          role_title TEXT DEFAULT '',
          employment_type TEXT DEFAULT 'full_time',
          employment_status TEXT DEFAULT 'active',
          start_date DATE,
          end_date DATE,
          probation_end_date DATE,
          manager_id INTEGER REFERENCES employees(id),
          email TEXT DEFAULT '',
          phone TEXT DEFAULT '',
          address TEXT DEFAULT '',
          suburb TEXT DEFAULT '',
          state TEXT DEFAULT '',
          postcode TEXT DEFAULT '',
          traffic_role_level TEXT DEFAULT '',
          ticket_classification TEXT DEFAULT '',
          white_card_required INTEGER DEFAULT 0,
          medical_required INTEGER DEFAULT 0,
          allocatable INTEGER DEFAULT 1,
          blocked_from_allocation INTEGER DEFAULT 0,
          block_reason TEXT DEFAULT '',
          induction_status TEXT DEFAULT 'pending',
          ppe_issued_status TEXT DEFAULT 'not_issued',
          uniform_issued_status TEXT DEFAULT 'not_issued',
          company_vehicle_assigned TEXT DEFAULT '',
          primary_work_region TEXT DEFAULT '',
          base_location TEXT DEFAULT '',
          emergency_contact_name TEXT DEFAULT '',
          emergency_contact_phone TEXT DEFAULT '',
          emergency_contact_relationship TEXT DEFAULT '',
          date_of_birth DATE,
          payroll_reference TEXT DEFAULT '',
          internal_notes TEXT DEFAULT '',
          active INTEGER DEFAULT 1,
          linked_crew_member_id INTEGER REFERENCES crew_members(id),
          linked_user_id INTEGER REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_code ON employees(employee_code)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(employment_status)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(manager_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_crew ON employees(linked_crew_member_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(linked_user_id)'); } catch(e) {}

      // --- B. employee_documents table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          document_type TEXT NOT NULL DEFAULT 'other',
          document_name TEXT NOT NULL,
          filename TEXT NOT NULL,
          original_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          issue_date DATE,
          expiry_date DATE,
          mandatory INTEGER DEFAULT 0,
          verification_status TEXT DEFAULT 'pending',
          verified_by_id INTEGER REFERENCES users(id),
          verified_at DATETIME,
          notes TEXT DEFAULT '',
          uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_employee ON employee_documents(employee_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_type ON employee_documents(document_type)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_expiry ON employee_documents(expiry_date)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empdocs_verification ON employee_documents(verification_status)'); } catch(e) {}

      // --- C. employee_competencies table ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS employee_competencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          competency_type TEXT NOT NULL DEFAULT 'other',
          competency_name TEXT NOT NULL,
          competency_level TEXT DEFAULT '',
          issue_date DATE,
          expiry_date DATE,
          status TEXT DEFAULT 'valid',
          mandatory_for_role INTEGER DEFAULT 0,
          linked_document_id INTEGER REFERENCES employee_documents(id),
          notes TEXT DEFAULT '',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_employee ON employee_competencies(employee_id)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_type ON employee_competencies(competency_type)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_expiry ON employee_competencies(expiry_date)'); } catch(e) {}
      try { db.exec('CREATE INDEX IF NOT EXISTS idx_empcomp_status ON employee_competencies(status)'); } catch(e) {}

      // --- D. Expand users role CHECK to include 'hr' and 'sales' ---
      const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const userSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (userSql && userSql.sql && !userSql.sql.includes("'hr'")) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
          CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            full_name TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance','hr','sales')),
            active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            email_notifications_enabled INTEGER DEFAULT 1,
            notification_frequency TEXT DEFAULT 'immediate'
          );
        `);
        db.exec(`
          INSERT INTO users_new (id, username, password_hash, full_name, email, role, active, created_at, email_notifications_enabled, notification_frequency)
          SELECT id, username, password_hash, full_name, email, role, active, created_at,
            COALESCE(email_notifications_enabled, 1),
            COALESCE(notification_frequency, 'immediate')
          FROM users;
        `);
        db.exec('DROP TABLE users;');
        db.exec('ALTER TABLE users_new RENAME TO users;');
        db.pragma('foreign_keys = ON');
      }

      // --- E. Auto-seed employees from crew_members ---
      const crewRows = db.prepare('SELECT * FROM crew_members WHERE active = 1').all();
      const insertEmp = db.prepare(`
        INSERT OR IGNORE INTO employees (employee_code, first_name, last_name, full_name, company, employment_type, email, phone, traffic_role_level, induction_status, active, linked_crew_member_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
      `);
      for (const cm of crewRows) {
        const parts = (cm.full_name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.slice(1).join(' ') || '';
        const empType = cm.employment_type || 'full_time';
        const inductionStatus = cm.induction_status || (cm.induction_date ? 'completed' : 'pending');
        insertEmp.run(
          cm.employee_id || null,
          firstName, lastName, cm.full_name || '',
          cm.company || '',
          empType,
          cm.email || '', cm.phone || '',
          cm.tcp_level || cm.role || '',
          inductionStatus,
          cm.id
        );
      }

      // --- F. Seed HR settings categories ---
      const insertSetting = db.prepare(`
        INSERT OR IGNORE INTO app_settings (category, key, label, display_order, is_active)
        VALUES (?, ?, ?, ?, 1)
      `);
      // Employment types
      [['full_time','Full Time'],['part_time','Part Time'],['casual','Casual'],['subcontractor','Subcontractor']].forEach(([k,l], i) => {
        insertSetting.run('hr_employment_types', k, l, i+1);
      });
      // Employment statuses
      [['active','Active'],['onboarding','Onboarding'],['on_leave','On Leave'],['suspended','Suspended'],['inactive','Inactive'],['offboarded','Offboarded']].forEach(([k,l], i) => {
        insertSetting.run('hr_employment_statuses', k, l, i+1);
      });
      // Divisions
      [['operations','Operations'],['planning','Planning'],['admin','Admin'],['safety','Safety'],['finance','Finance'],['hr','Human Resources'],['sales','Sales']].forEach(([k,l], i) => {
        insertSetting.run('hr_divisions', k, l, i+1);
      });
      // Document types
      [['contract','Contract'],['licence','Licence'],['white_card','White Card'],['induction_record','Induction Record'],['training_certificate','Training Certificate'],['voc','VOC'],['medical','Medical'],['id','ID'],['policy_acknowledgement','Policy Acknowledgement'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_document_types', k, l, i+1);
      });
      // Competency types
      [['traffic_ticket','Traffic Ticket'],['white_card','White Card'],['first_aid','First Aid'],['plant_ticket','Plant Ticket'],['driver_licence','Driver Licence'],['hr_licence','HR Licence'],['voc','VOC'],['induction','Induction'],['medical_clearance','Medical Clearance'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_competency_types', k, l, i+1);
      });
      // PPE statuses
      [['not_issued','Not Issued'],['issued','Issued'],['partial','Partial'],['returned','Returned']].forEach(([k,l], i) => {
        insertSetting.run('hr_ppe_statuses', k, l, i+1);
      });
      // Block reasons
      [['expired_licence','Expired Licence'],['missing_induction','Missing Induction'],['medical_expired','Medical Expired'],['disciplinary','Disciplinary'],['other','Other']].forEach(([k,l], i) => {
        insertSetting.run('hr_block_reasons', k, l, i+1);
      });

      recordMigration.run(38, 'HR / People Ops Foundation — employees, documents, competencies, role expansion');
      console.log('Migration 38 complete.');
    } catch (e) {
      try { db.pragma('foreign_keys = ON'); } catch(re) {}
      try { db.exec('DROP TABLE IF EXISTS users_new'); } catch(re) {}
      console.error('Migration 38 error:', e.message);
    }
  }

  // =============================================
  // Migration 39: Seed realistic demo budget data for active jobs
  // =============================================
  if (!isMigrationApplied.get(39)) {
    try {
      // Only seed if job_budgets is empty (don't overwrite real data)
      const existingBudgets = db.prepare('SELECT COUNT(*) as c FROM job_budgets').get().c;
      if (existingBudgets === 0) {
        const activeJobs = db.prepare("SELECT id, job_number, contract_value FROM jobs WHERE status IN ('active','won','on_hold') ORDER BY job_number").all();
        if (activeJobs.length > 0) {
          const insertBudget = db.prepare(`INSERT OR IGNORE INTO job_budgets (job_id, contract_value, budget_labour, budget_materials, budget_subcontractors, budget_equipment, budget_other, budget_contingency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const insertCost = db.prepare(`INSERT INTO cost_entries (job_id, budget_id, category, description, amount, entry_date, invoice_ref, supplier, entered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

          const adminUser = db.prepare("SELECT id FROM users WHERE role IN ('admin','finance') LIMIT 1").get();
          const enteredBy = adminUser ? adminUser.id : 1;

          const profiles = [
            { labourPct: 0.50, matPct: 0.08, subPct: 0.18, equipPct: 0.14, otherPct: 0.03, contPct: 0.07 },
            { labourPct: 0.52, matPct: 0.06, subPct: 0.20, equipPct: 0.12, otherPct: 0.04, contPct: 0.06 },
            { labourPct: 0.48, matPct: 0.10, subPct: 0.15, equipPct: 0.16, otherPct: 0.03, contPct: 0.08 },
            { labourPct: 0.55, matPct: 0.05, subPct: 0.17, equipPct: 0.13, otherPct: 0.04, contPct: 0.06 },
          ];

          const contractValues = [185000, 320000, 95000, 450000, 78000, 520000, 125000, 680000, 210000, 145000];
          const spendPcts = [0.38, 0.62, 0.78, 0.22, 0.45, 0.05, 0.55, 0.12, 0.35, 0.68];
          const daysAgo39 = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

          activeJobs.forEach((job, i) => {
            const contractVal = job.contract_value || contractValues[i % contractValues.length];
            const p = profiles[i % profiles.length];
            const totalBudget = contractVal * 0.92;

            insertBudget.run(job.id, contractVal,
              Math.round(totalBudget * p.labourPct), Math.round(totalBudget * p.matPct),
              Math.round(totalBudget * p.subPct), Math.round(totalBudget * p.equipPct),
              Math.round(totalBudget * p.otherPct), Math.round(totalBudget * p.contPct),
              'Auto-seeded budget');

            const budgetRow = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(job.id);
            if (!budgetRow) return;

            const spendPct = spendPcts[i % spendPcts.length];
            const totalSpend = totalBudget * spendPct;

            const costEntries = [
              { cat: 'labour', pct: 0.55, desc: 'Crew labour — weeks 1-' + Math.ceil(spendPct * 20), supplier: 'Internal', pre: 'LAB' },
              { cat: 'equipment', pct: 0.18, desc: 'TMA & equipment hire', supplier: 'T&S Fleet', pre: 'EQP' },
              { cat: 'materials', pct: 0.10, desc: 'Signage, cones & delineators', supplier: 'Traffix Devices', pre: 'MAT' },
              { cat: 'subcontractors', pct: 0.14, desc: 'Line marking & civil sub', supplier: 'Roadline Markings', pre: 'SUB' },
              { cat: 'other', pct: 0.03, desc: 'Permits & admin', supplier: 'Various', pre: 'OTH' },
            ];

            costEntries.forEach((ce, ci) => {
              const amount = Math.round(totalSpend * ce.pct);
              if (amount <= 0) return;
              insertCost.run(job.id, budgetRow.id, ce.cat, ce.desc, amount,
                daysAgo39(Math.max(1, Math.round((ci + 1) * 7 * spendPct))),
                ce.pre + '-' + job.job_number + '-' + String(ci + 1).padStart(3, '0'),
                ce.supplier, enteredBy);
            });

            if (!job.contract_value) {
              db.prepare('UPDATE jobs SET contract_value = ? WHERE id = ?').run(contractVal, job.id);
            }
          });

          console.log('Migration 39: Seeded budget data for ' + activeJobs.length + ' jobs');
        }
      }
      recordMigration.run(39, 'Seed realistic demo budget data');
      console.log('Migration 39 complete.');
    } catch (e) {
      console.error('Migration 39 error:', e.message);
    }
  }

  // =============================================
  // Migration 40: Seed comprehensive demo data (schema-only marker)
  // Actual data seeded in seedDemoData() after initial user/job seed
  // =============================================
  if (!isMigrationApplied.get(40)) {
    // Add preferences column to users if missing
    try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
    recordMigration.run(40, 'Seed comprehensive demo data — allocations, equipment, activity, CRM, updates');
    console.log('Migration 40 complete (schema marker).');
  }

  // =============================================
  // Migration 41: Induction Module
  // =============================================
  if (!isMigrationApplied.get(41)) {
    console.log('Running migration 41: Induction Module');

    db.exec(`
      CREATE TABLE IF NOT EXISTS induction_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        access_token TEXT UNIQUE NOT NULL,
        payment_type TEXT NOT NULL CHECK(payment_type IN ('cash', 'tfn', 'abn')),
        status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft', 'submitted', 'approved', 'rejected')),

        full_name TEXT NOT NULL DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        date_of_birth DATE,
        address TEXT DEFAULT '',
        suburb TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postcode TEXT DEFAULT '',

        can_drive TEXT DEFAULT '',
        can_drive_truck TEXT DEFAULT '',
        has_injuries TEXT DEFAULT '',
        injury_details TEXT DEFAULT '',
        is_indigenous TEXT DEFAULT '',

        white_card_number TEXT DEFAULT '',
        tc_licence_number TEXT DEFAULT '',
        drivers_licence_number TEXT DEFAULT '',

        white_card_photo TEXT DEFAULT '',
        tc_licence_photo TEXT DEFAULT '',
        drivers_licence_photo TEXT DEFAULT '',

        tax_file_number TEXT DEFAULT '',
        bank_bsb TEXT DEFAULT '',
        bank_account_number TEXT DEFAULT '',
        bank_account_name TEXT DEFAULT '',
        abn_number TEXT DEFAULT '',

        company_intro_completed INTEGER DEFAULT 0,
        ppe_acknowledged INTEGER DEFAULT 0,

        reviewed_by_id INTEGER REFERENCES users(id),
        reviewed_at DATETIME,
        review_notes TEXT DEFAULT '',

        linked_crew_member_id INTEGER REFERENCES crew_members(id),

        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_induction_token ON induction_submissions(access_token);
      CREATE INDEX IF NOT EXISTS idx_induction_status ON induction_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_induction_payment ON induction_submissions(payment_type);
      CREATE INDEX IF NOT EXISTS idx_induction_submitted ON induction_submissions(submitted_at);

      CREATE TABLE IF NOT EXISTS induction_presentations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL CHECK(module IN ('employee_guide', 'tc_training_1')),
        presented_by_id INTEGER NOT NULL REFERENCES users(id),
        attendee_names TEXT DEFAULT '',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        last_slide INTEGER DEFAULT 1,
        total_slides INTEGER NOT NULL,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_presentations_module ON induction_presentations(module);
    `);

    recordMigration.run(41, 'Induction Module — submissions and presentations tables');
    console.log('Migration 41 complete.');
  }

  // =============================================
  // Migration 42: Add created_by to tasks
  // =============================================
  if (!isMigrationApplied.get(42)) {
    console.log('Running migration 42: Add created_by to tasks');
    try { db.exec('ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)'); } catch (e) { /* column may already exist */ }
    recordMigration.run(42, 'Add created_by column to tasks table');
    console.log('Migration 42 complete.');
  }

  // =============================================
  // Migration 43: Backfill created_by on existing tasks
  // =============================================
  if (!isMigrationApplied.get(43)) {
    console.log('Running migration 43: Backfill created_by on existing tasks');
    // Set created_by to the first admin user for any tasks missing it
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (firstAdmin) {
      db.prepare('UPDATE tasks SET created_by = ? WHERE created_by IS NULL').run(firstAdmin.id);
    }
    recordMigration.run(43, 'Backfill created_by on existing tasks');
    console.log('Migration 43 complete.');
  }

  // Migration 44: Add bank_name column to induction_submissions
  if (!isMigrationApplied.get(44)) {
    console.log('Running migration 44: Add bank_name to induction_submissions');
    db.exec(`ALTER TABLE induction_submissions ADD COLUMN bank_name TEXT DEFAULT ''`);
    recordMigration.run(44, 'Add bank_name to induction_submissions');
    console.log('Migration 44 complete.');
  }

  // =============================================
  // Migration 45: Client operational fields + import real client data
  // =============================================
  if (!isMigrationApplied.get(45)) {
    console.log('Running migration 45: Client operational fields + real client data');
    try {
      // Add operational columns to clients
      const clientCols45 = [
        "ALTER TABLE clients ADD COLUMN cancellation_window_hrs INTEGER DEFAULT 3",
        "ALTER TABLE clients ADD COLUMN is_non_billable INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN is_cash_only INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN credit_stop INTEGER DEFAULT 0",
        "ALTER TABLE clients ADD COLUMN credit_stop_reason TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN default_purchase_order TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_suburb TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_state TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_postcode TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN billing_attention TEXT DEFAULT ''",
        "ALTER TABLE clients ADD COLUMN external_id TEXT DEFAULT ''",
      ];
      for (const sql of clientCols45) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }

      // Add send_docket / send_invoice to client_contacts
      const contactCols45 = [
        "ALTER TABLE client_contacts ADD COLUMN send_docket INTEGER DEFAULT 0",
        "ALTER TABLE client_contacts ADD COLUMN send_invoice INTEGER DEFAULT 0",
      ];
      for (const sql of contactCols45) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }

      // Import real client data
      const insertClient45 = db.prepare(`
        INSERT INTO clients (external_id, company_name, abn, cancellation_window_hrs, is_non_billable, is_cash_only, credit_stop, credit_stop_reason, payment_terms, default_purchase_order, company_type, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client', 1)
      `);
      const insertContact45 = db.prepare(`
        INSERT INTO client_contacts (company_id, contact_type, company, full_name, phone, email, send_docket, send_invoice, is_primary)
        VALUES (?, 'client', ?, ?, ?, ?, ?, ?, ?)
      `);

      const clients45 = [
        {id:"74577",name:"2 Way Concrete",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Frank 2-Way",phone:"0410428084",email:null,docket:false,invoice:false}]},
        {id:"94296",name:"Abergeldie Complex Infrastructure",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Harry Iqbal",phone:"0499 516 282",email:null,docket:false,invoice:false}]},
        {id:"73797",name:"Active Civil Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Adam Mourad",phone:"0490333329",email:null,docket:false,invoice:false}]},
        {id:"73796",name:"AGM Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ghassan Al-Kamisie",phone:"0401272829",email:null,docket:false,invoice:false}]},
        {id:"93884",name:"Al-Faisal College",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Waed Khalifeh",phone:"0405 288 828",email:null,docket:false,invoice:false}]},
        {id:"74461",name:"All Civil Works",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Charbel Younan",phone:"0433922290",email:null,docket:false,invoice:false}]},
        {id:"27671",name:"Alpha Cranes & Rigging",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Aaron Alpha",phone:"0414 525 556",email:null,docket:false,invoice:false}]},
        {id:"74154",name:"AM2PM Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Craig AM2PM",phone:"0412393300",email:null,docket:false,invoice:false}]},
        {id:"36003",name:"ANR Engineering",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Sami ANR",phone:"0439 038 993",email:null,docket:false,invoice:false}]},
        {id:"75094",name:"Apex Sewer & Water",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Matthew Clancey",phone:"0432073840",email:null,docket:false,invoice:false}]},
        {id:"90622",name:"Atlantis",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Sarah Atlantis",phone:"0432 282 380",email:null,docket:false,invoice:false}]},
        {id:"74215",name:"Atlas Plumbing",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Pat Atlas",phone:"0404604050",email:null,docket:false,invoice:false}]},
        {id:"73798",name:"Axial Construction",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Michael Cassisi",phone:"0407727170",email:null,docket:false,invoice:false}]},
        {id:"34044",name:"Blaq Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Wasim Blaq",phone:"0430 838 488",email:null,docket:false,invoice:false}]},
        {id:"73799",name:"Brushwood Engineering",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jason Brushwood",phone:"0412898983",email:null,docket:false,invoice:false}]},
        {id:"77632",name:"Build Life",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Elias Saad",phone:"0404676767",email:null,docket:false,invoice:false}]},
        {id:"86602",name:"Builtwise Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmed Builtwise",phone:"0423188888",email:null,docket:false,invoice:false}]},
        {id:"35767",name:"BXD Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jacob BXD",phone:"0425 696 969",email:null,docket:false,invoice:false}]},
        {id:"94092",name:"Carlton Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Marwan Nassar",phone:"0403 077 887",email:null,docket:false,invoice:false}]},
        {id:"90484",name:"CIP Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Alex CIP",phone:"0416 838 288",email:null,docket:false,invoice:false}]},
        {id:"75913",name:"City Line Marking",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Walid City",phone:"0414140004",email:null,docket:false,invoice:false}]},
        {id:"87649",name:"City Traffic",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Peter City Traffic",phone:"0413254000",email:null,docket:false,invoice:false}]},
        {id:"88399",name:"Civil Com Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"George Civil",phone:"0413 060 506",email:null,docket:false,invoice:false}]},
        {id:"35733",name:"Civil Environmental Services",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Steve CES",phone:"0434616113",email:null,docket:false,invoice:false}]},
        {id:"73800",name:"Civil Environmental Services",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmed CES",phone:"0426041882",email:null,docket:false,invoice:false}]},
        {id:"32043",name:"Civil Ops",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"32044",name:"Civil Ops",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Mitch",phone:"0473549737",email:null,docket:false,invoice:false}]},
        {id:"33209",name:"Combined",abn:null,cancel:3,nonBill:true,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Taj",phone:"+61 416 221 801",email:null,docket:false,invoice:false}]},
        {id:"92421",name:"Compass Developments",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Liam Marshall",phone:"0451 006 293",email:null,docket:false,invoice:false},{name:"Adnan Compass",phone:"0421316669",email:null,docket:false,invoice:false}]},
        {id:"83863",name:"Conquest",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Danny Conquest",phone:"0413 803 386",email:null,docket:false,invoice:false}]},
        {id:"73801",name:"Construx Solutions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jack Construx",phone:"0400 777 666",email:null,docket:false,invoice:false}]},
        {id:"85666",name:"Cubic Construction",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Luke Cubic",phone:"0404 770 900",email:null,docket:false,invoice:false}]},
        {id:"73805",name:"D&M Asphalt",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Danny D&M",phone:"0424 897 733",email:null,docket:false,invoice:false}]},
        {id:"89044",name:"Daracon Group",abn:"82 002 344 667",cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Nathan Hillier",phone:"0499 941 623",email:"nathan.hillier@daracon.com.au",docket:true,invoice:false},{name:"Simpson Wong",phone:"0427 000 834",email:"simpson.wong@daracon.com.au",docket:false,invoice:false},{name:"Chandan Naidu",phone:"0432 987 654",email:"chandan.naidu@daracon.com.au",docket:false,invoice:false}]},
        {id:"91246",name:"Daracon Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"74792",name:"Delaney Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Michael Delaney",phone:"0407414714",email:null,docket:false,invoice:false}]},
        {id:"78459",name:"Designline Building",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Maysam Designline",phone:"0449 225 885",email:null,docket:false,invoice:false}]},
        {id:"84307",name:"Domain Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Frank Domain",phone:"0402338831",email:null,docket:false,invoice:false}]},
        {id:"78546",name:"Dynamic Lanemarking",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ross Dynamic",phone:"0418 428 080",email:null,docket:false,invoice:false}]},
        {id:"88257",name:"E.M.O Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jihad EMO",phone:"0414 660 090",email:null,docket:false,invoice:false}]},
        {id:"31906",name:"Earthbuilt",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Ahmad Earthbuilt",phone:"0421 601 061",email:null,docket:false,invoice:false}]},
        {id:"86054",name:"Easter's Pacific",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Greg Easter",phone:"0414 242 829",email:null,docket:false,invoice:false}]},
        {id:"29781",name:"Fleek Constructions",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Jason Fleek",phone:"0410335556",email:null,docket:false,invoice:false}]},
        {id:"33644",name:"Ghass",abn:null,cancel:3,nonBill:true,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[]},
        {id:"73807",name:"Greenbrook",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Nathaniel Greenbrook",phone:"0408 727 343",email:null,docket:false,invoice:false}]},
        {id:"73802",name:"Ground King Civil",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Marcus King",phone:"0424448000",email:null,docket:false,invoice:false}]},
        {id:"73803",name:"H Lap Projects",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Hisham H-Lap",phone:"0412040030",email:null,docket:false,invoice:false}]},
        {id:"91325",name:"Hacer Group",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Weston Hacer",phone:"0436 083 663",email:null,docket:false,invoice:false}]},
        {id:"87594",name:"HPAC",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Steve HPAC",phone:"0410 696 060",email:null,docket:false,invoice:false}]},
        {id:"73807",name:"I Connected",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Fatih Cantas",phone:"0477 777 877",email:null,docket:false,invoice:false},{name:"Harry ICA",phone:"0487409488",email:null,docket:false,invoice:false}]},
        {id:"74156",name:"I Connected",abn:null,cancel:3,nonBill:false,cash:false,creditStop:false,creditReason:null,payTerm:null,po:null,contacts:[{name:"Fatih Cantas",phone:"0477 777 877",email:null,docket:false,invoice:false}]},
      ];

      for (const c of clients45) {
        // Check if client with same name + external_id already exists
        const existing = db.prepare('SELECT id FROM clients WHERE company_name = ? AND external_id = ?').get(c.name, c.id);
        let clientDbId;
        if (existing) {
          clientDbId = existing.id;
          // Update operational fields
          db.prepare(`UPDATE clients SET cancellation_window_hrs = ?, is_non_billable = ?, is_cash_only = ?, credit_stop = ?, credit_stop_reason = ?, abn = COALESCE(NULLIF(?, ''), abn), external_id = ? WHERE id = ?`)
            .run(c.cancel, c.nonBill ? 1 : 0, c.cash ? 1 : 0, c.creditStop ? 1 : 0, c.creditReason || '', c.abn || '', c.id, clientDbId);
        } else {
          const r = insertClient45.run(c.id, c.name, c.abn || '', c.cancel, c.nonBill ? 1 : 0, c.cash ? 1 : 0, c.creditStop ? 1 : 0, c.creditReason || '', c.payTerm || '', c.po || '');
          clientDbId = r.lastInsertRowid;
        }

        // Insert contacts
        for (let i = 0; i < c.contacts.length; i++) {
          const ct = c.contacts[i];
          // Check if contact already exists for this company
          const existingContact = db.prepare('SELECT id FROM client_contacts WHERE company_id = ? AND full_name = ?').get(clientDbId, ct.name);
          if (!existingContact) {
            insertContact45.run(clientDbId, c.name, ct.name, ct.phone || '', ct.email || '', ct.docket ? 1 : 0, ct.invoice ? 1 : 0, i === 0 ? 1 : 0);
          }
        }
      }

      console.log('Migration 45: Imported ' + clients45.length + ' clients with contacts');
    } catch (e) {
      console.error('Migration 45 error:', e.message);
    }
    recordMigration.run(45, 'Client operational fields + real client data');
    console.log('Migration 45 complete.');
  }

  // Migration 46: Split name fields + payment_type on employees & induction_submissions
  if (!isMigrationApplied.get(46)) {
    console.log('Running migration 46: Split name fields + payment_type');
    // Add middle_name and payment_type to employees
    try { db.exec(`ALTER TABLE employees ADD COLUMN middle_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE employees ADD COLUMN payment_type TEXT DEFAULT ''`); } catch(e) {}
    // Add split name fields to induction_submissions
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN first_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN middle_name TEXT DEFAULT ''`); } catch(e) {}
    try { db.exec(`ALTER TABLE induction_submissions ADD COLUMN last_name TEXT DEFAULT ''`); } catch(e) {}
    recordMigration.run(46, 'Split name fields + payment_type');
    console.log('Migration 46 complete.');
  }

  // Migration 47: Pay rate fields on employees
  if (!isMigrationApplied.get(47)) {
    console.log('Running migration 47: Employee pay rates');
    const rateColumns = [
      'rate_day', 'rate_ot', 'rate_dt',
      'rate_night', 'rate_night_ot', 'rate_night_dt',
      'rate_travel', 'rate_meal', 'rate_weekend'
    ];
    rateColumns.forEach(col => {
      try { db.exec(`ALTER TABLE employees ADD COLUMN ${col} REAL DEFAULT 0`); } catch(e) {}
    });
    recordMigration.run(47, 'Employee pay rates');
    console.log('Migration 47 complete.');
  }

  // Migration 48: Fix CHECK constraints — users role + incidents type
  if (!isMigrationApplied.get(48)) {
    console.log('Running migration 48: Fix CHECK constraints');
    db.pragma('foreign_keys = OFF');

    // Fix users table — add hr, sales roles alongside management, marketing, accounts
    try {
      const allRoles = "'admin','operations','planning','finance','hr','sales','management','marketing','accounts'";
      const userCols = db.pragma('table_info(users)').map(c => c.name);
      db.exec(`CREATE TABLE users_fix (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL CHECK(role IN (${allRoles})),
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        email_notifications_enabled INTEGER DEFAULT 1,
        notification_frequency TEXT DEFAULT 'immediate'
      )`);
      const cols = ['id','username','password_hash','full_name','email','role','active','created_at',
        'email_notifications_enabled','notification_frequency'].filter(c => userCols.includes(c));
      db.exec(`INSERT INTO users_fix (${cols.join(',')}) SELECT ${cols.join(',')} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_fix RENAME TO users');
      console.log('  Fixed users CHECK constraint');
    } catch(e) { console.error('  Users fix error:', e.message); }

    // Fix incidents table — add all incident types
    try {
      const allTypes = "'near_miss','traffic_incident','worker_injury','vehicle_damage','public_complaint','environmental','injury','hazard','property_damage','vehicle','other'";
      const incCols = db.pragma('table_info(incidents)').map(c => c.name);
      if (incCols.length > 0) {
        const colDefs = db.pragma('table_info(incidents)');
        // Build new table with same columns but fixed CHECK
        let createSQL = 'CREATE TABLE incidents_fix (';
        const colParts = colDefs.map(c => {
          let def = `${c.name} ${c.type || 'TEXT'}`;
          if (c.pk) def = `${c.name} INTEGER PRIMARY KEY AUTOINCREMENT`;
          if (c.name === 'incident_type') def = `incident_type TEXT NOT NULL CHECK(incident_type IN (${allTypes}))`;
          if (c.notnull && !c.pk && c.name !== 'incident_type') def += ' NOT NULL';
          if (c.dflt_value !== null && !c.pk) def += ` DEFAULT ${c.dflt_value}`;
          return def;
        });
        createSQL += colParts.join(', ') + ')';
        db.exec(createSQL);
        const safeCols = incCols.join(',');
        db.exec(`INSERT INTO incidents_fix (${safeCols}) SELECT ${safeCols} FROM incidents`);
        db.exec('DROP TABLE incidents');
        db.exec('ALTER TABLE incidents_fix RENAME TO incidents');
        console.log('  Fixed incidents CHECK constraint');
      }
    } catch(e) { console.error('  Incidents fix error:', e.message); }

    db.pragma('foreign_keys = ON');
    recordMigration.run(48, 'Fix CHECK constraints');
    console.log('Migration 48 complete.');
  }

  // Migration 49: Bookings module tables
  if (!isMigrationApplied.get(49)) {
    console.log('Running migration 49: Bookings module');
    db.exec(`
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_number TEXT UNIQUE,
        job_id INTEGER REFERENCES jobs(id),
        client_id INTEGER REFERENCES clients(id),
        title TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK(status IN ('unconfirmed','confirmed','green_to_go','in_progress','completed','cancelled','on_hold')),
        depot TEXT DEFAULT '',
        start_datetime TEXT NOT NULL,
        end_datetime TEXT NOT NULL,
        site_address TEXT DEFAULT '',
        suburb TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postcode TEXT DEFAULT '',
        order_number TEXT DEFAULT '',
        billing_code TEXT DEFAULT '',
        client_contact TEXT DEFAULT '',
        supervisor_id INTEGER REFERENCES crew_members(id),
        requirements_text TEXT DEFAULT '',
        is_emergency INTEGER DEFAULT 0,
        is_callout INTEGER DEFAULT 0,
        billable INTEGER DEFAULT 1,
        invoiced INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(start_datetime);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      CREATE INDEX IF NOT EXISTS idx_bookings_depot ON bookings(depot);
      CREATE INDEX IF NOT EXISTS idx_bookings_job ON bookings(job_id);

      CREATE TABLE IF NOT EXISTS booking_crew (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        role_on_site TEXT DEFAULT '',
        status TEXT DEFAULT 'assigned' CHECK(status IN ('assigned','confirmed','declined','completed')),
        confirmed_at DATETIME,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_crew_booking ON booking_crew(booking_id);
      CREATE INDEX IF NOT EXISTS idx_booking_crew_member ON booking_crew(crew_member_id);

      CREATE TABLE IF NOT EXISTS booking_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        is_private INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_notes_booking ON booking_notes(booking_id);

      CREATE TABLE IF NOT EXISTS booking_vehicles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        vehicle_name TEXT DEFAULT '',
        registration TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_vehicles_booking ON booking_vehicles(booking_id);
    `);
    recordMigration.run(49, 'Bookings module tables');
    console.log('Migration 49 complete.');
  }

  // Migration 50: Plans register — add missing fields from Excel register
  if (!isMigrationApplied.get(50)) {
    console.log('Running migration 50: Plans register extra fields');
    const cols = [
      ['reference_number', 'TEXT DEFAULT \'\''],
      ['rol_required', 'INTEGER DEFAULT 0'],
      ['rol_response', 'TEXT DEFAULT \'\''],
      ['bus_approvals_required', 'INTEGER DEFAULT 0'],
      ['bus_approvals_response', 'TEXT DEFAULT \'\''],
      ['client_pm', 'TEXT DEFAULT \'\''],
      ['costs', 'REAL DEFAULT 0'],
      ['action_required', 'TEXT DEFAULT \'\''],
      ['charge_client', 'INTEGER DEFAULT 0'],
      ['charge_amount', 'REAL DEFAULT 0'],
      ['invoiced', 'INTEGER DEFAULT 0'],
      ['invoice_number', 'TEXT DEFAULT \'\''],
      ['police_notification', 'INTEGER DEFAULT 0'],
      ['letter_drop', 'INTEGER DEFAULT 0'],
    ];
    cols.forEach(([col, type]) => {
      try { db.exec(`ALTER TABLE compliance ADD COLUMN ${col} ${type}`); } catch(e) {}
    });
    recordMigration.run(50, 'Plans register extra fields');
    console.log('Migration 50 complete.');
  }

  // Migration 51: Booking dockets — time tracking + signatures
  if (!isMigrationApplied.get(51)) {
    console.log('Running migration 51: Booking dockets');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_dockets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        docket_number TEXT UNIQUE,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending_signoff','signed','finalised')),
        physical_docket_number TEXT DEFAULT '',
        client_billing_ref TEXT DEFAULT '',
        bill_from TEXT DEFAULT '',
        site_address TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        private_notes TEXT DEFAULT '',
        client_feedback TEXT DEFAULT '',
        worker_signature TEXT DEFAULT '',
        worker_signed_name TEXT DEFAULT '',
        worker_signed_at DATETIME,
        client_signature TEXT DEFAULT '',
        client_signed_name TEXT DEFAULT '',
        client_signed_at DATETIME,
        created_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_dockets_booking ON booking_dockets(booking_id);
      CREATE INDEX IF NOT EXISTS idx_dockets_status ON booking_dockets(status);

      CREATE TABLE IF NOT EXISTS docket_time_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        docket_id INTEGER NOT NULL REFERENCES booking_dockets(id) ON DELETE CASCADE,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        start_on_site DATETIME,
        finish_on_site DATETIME,
        first_break REAL DEFAULT 0,
        first_break_at TEXT DEFAULT '',
        travel REAL DEFAULT 0,
        lafha INTEGER DEFAULT 0,
        total_hours REAL DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_time_entries_docket ON docket_time_entries(docket_id);
      CREATE INDEX IF NOT EXISTS idx_time_entries_crew ON docket_time_entries(crew_member_id);
    `);
    recordMigration.run(51, 'Booking dockets');
    console.log('Migration 51 complete.');
  }

  // Migration 52: Booking documents
  if (!isMigrationApplied.get(52)) {
    console.log('Running migration 52: Booking documents');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        document_type TEXT DEFAULT 'other',
        title TEXT NOT NULL DEFAULT '',
        description TEXT DEFAULT '',
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        uploaded_by_id INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_docs_booking ON booking_documents(booking_id);
    `);
    recordMigration.run(52, 'Booking documents');
    console.log('Migration 52 complete.');
  }

  // Migration 53: Booking resource requirements + equipment assignments
  if (!isMigrationApplied.get(53)) {
    console.log('Running migration 53: Booking requirements + equipment');
    db.exec(`
      CREATE TABLE IF NOT EXISTS booking_requirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        quantity_required INTEGER DEFAULT 1,
        quantity_assigned INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_req_booking ON booking_requirements(booking_id);

      CREATE TABLE IF NOT EXISTS booking_equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
        equipment_id INTEGER REFERENCES equipment(id),
        equipment_name TEXT DEFAULT '',
        equipment_type TEXT DEFAULT '',
        quantity INTEGER DEFAULT 1,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_booking_equip_booking ON booking_equipment(booking_id);
    `);
    recordMigration.run(53, 'Booking requirements + equipment');
    console.log('Migration 53 complete.');
  }

  // Migration 54: Operational Chat / Messaging Tables
  if (!isMigrationApplied.get(54)) {
    console.log('Running migration 54: Operational Chat / Messaging Tables');
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('job','incident','compliance','broadcast')),
        related_entity_id INTEGER NOT NULL,
        related_entity_type TEXT NOT NULL CHECK(related_entity_type IN ('job','incident','compliance')),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','locked')),
        created_by INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_thread_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_in_thread TEXT NOT NULL DEFAULT 'member' CHECK(role_in_thread IN ('owner','member','readonly')),
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        muted_at DATETIME,
        last_read_message_id INTEGER DEFAULT 0,
        UNIQUE(thread_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id),
        body TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT 'text' CHECK(message_type IN ('text','image','file','system')),
        reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        edited_at DATETIME,
        deleted_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_url TEXT NOT NULL,
        thumbnail_url TEXT DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        file_size INTEGER NOT NULL DEFAULT 0,
        original_name TEXT NOT NULL,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS message_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(message_id, mentioned_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chat_threads_type ON chat_threads(thread_type);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_entity ON chat_threads(related_entity_type, related_entity_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_status ON chat_threads(status);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_thread ON chat_thread_members(thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(mentioned_user_id);
      CREATE INDEX IF NOT EXISTS idx_message_mentions_message ON message_mentions(message_id);
    `);
    recordMigration.run(54, 'Operational Chat / Messaging Tables');
    console.log('Migration 54 complete.');
  }

  // Migration 55: Extend chat_threads for DMs, channels, announcements
  if (!isMigrationApplied.get(55)) {
    console.log('Running migration 55: DMs, channels, announcements');

    // Rebuild chat_threads with extended CHECK + nullable entity columns + new columns
    // Save existing data first
    const existingThreads = db.prepare('SELECT * FROM chat_threads').all();
    const existingMembers = db.prepare('SELECT * FROM chat_thread_members').all();

    // Disable FK temporarily for the rebuild
    db.pragma('foreign_keys = OFF');

    // Drop old tables (messages FK references chat_threads but we keep messages intact)
    db.exec('DROP TABLE IF EXISTS chat_thread_members');
    db.exec('DROP TABLE IF EXISTS chat_threads');

    // Create new tables with extended schema
    db.exec(`
      CREATE TABLE chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_type TEXT NOT NULL CHECK(thread_type IN ('job','incident','compliance','broadcast','dm','channel','announcement')),
        related_entity_id INTEGER,
        related_entity_type TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','locked')),
        is_default INTEGER NOT NULL DEFAULT 0,
        channel_slug TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE chat_thread_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_in_thread TEXT NOT NULL DEFAULT 'member' CHECK(role_in_thread IN ('owner','member','readonly')),
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        muted_at DATETIME,
        last_read_message_id INTEGER DEFAULT 0,
        UNIQUE(thread_id, user_id)
      );
    `);

    // Restore data
    if (existingThreads.length > 0) {
      const insertThread = db.prepare('INSERT INTO chat_threads (id, thread_type, related_entity_id, related_entity_type, title, status, is_default, channel_slug, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)');
      for (const t of existingThreads) {
        insertThread.run(t.id, t.thread_type, t.related_entity_id, t.related_entity_type, t.title, t.status, t.created_by, t.created_at, t.updated_at);
      }
    }
    if (existingMembers.length > 0) {
      const insertMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (id, thread_id, user_id, role_in_thread, joined_at, muted_at, last_read_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const m of existingMembers) {
        insertMember.run(m.id, m.thread_id, m.user_id, m.role_in_thread, m.joined_at, m.muted_at, m.last_read_message_id);
      }
    }

    // Re-enable FK
    db.pragma('foreign_keys = ON');

    // Recreate indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_threads_type ON chat_threads(thread_type);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_entity ON chat_threads(related_entity_type, related_entity_id);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_status ON chat_threads(status);
      CREATE INDEX IF NOT EXISTS idx_chat_threads_slug ON chat_threads(channel_slug);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_thread ON chat_thread_members(thread_id);
      CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);
    `);

    // Seed default channels
    const channels = [
      { slug: 'all-team', title: 'All Team', type: 'announcement', isDefault: 1 },
      { slug: 'operations', title: 'Operations', type: 'channel', isDefault: 1 },
      { slug: 'field-workers', title: 'Field Workers', type: 'channel', isDefault: 1 },
      { slug: 'supervisors', title: 'Supervisors', type: 'channel', isDefault: 1 },
      { slug: 'planning', title: 'Planning', type: 'channel', isDefault: 1 },
    ];
    const insertChannel = db.prepare('INSERT OR IGNORE INTO chat_threads (thread_type, title, status, is_default, channel_slug) VALUES (?, ?, \'active\', ?, ?)');
    for (const ch of channels) {
      const exists = db.prepare('SELECT id FROM chat_threads WHERE channel_slug = ?').get(ch.slug);
      if (!exists) {
        insertChannel.run(ch.type, ch.title, ch.isDefault, ch.slug);
      }
    }

    // Auto-add all existing active users to All Team channel
    const allTeam = db.prepare("SELECT id FROM chat_threads WHERE channel_slug = 'all-team'").get();
    if (allTeam) {
      const users = db.prepare('SELECT id FROM users WHERE active = 1').all();
      const addMember = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
      for (const u of users) {
        addMember.run(allTeam.id, u.id, 'member');
      }
    }

    // Post welcome system messages in default channels
    const welcomeStmt = db.prepare("INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, NULL, ?, 'system')");
    const allChannels = db.prepare("SELECT id, title, channel_slug FROM chat_threads WHERE is_default = 1").all();
    for (const ch of allChannels) {
      const hasMessages = db.prepare('SELECT id FROM messages WHERE thread_id = ? LIMIT 1').get(ch.id);
      if (!hasMessages) {
        welcomeStmt.run(ch.id, `Welcome to ${ch.title}. This channel was created automatically.`);
      }
    }

    recordMigration.run(55, 'DMs, channels, announcements');
    console.log('Migration 55 complete.');
  }

  // Migration 56: Pinned messages + message editing support
  if (!isMigrationApplied.get(56)) {
    console.log('Running migration 56: Pinned messages');
    const cols56 = [
      "ALTER TABLE messages ADD COLUMN pinned_at DATETIME",
      "ALTER TABLE messages ADD COLUMN pinned_by INTEGER REFERENCES users(id)",
    ];
    for (const sql of cols56) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }
    recordMigration.run(56, 'Pinned messages');
    console.log('Migration 56 complete.');
  }

  // Migration 57: Clock events, crew availability, docket signatures, safety forms, employee leave
  if (!isMigrationApplied.get(57)) {
    console.log('Running migration 57: Sprint 2 tables — clock events, availability, dockets, safety forms, leave');
    db.exec(`
      CREATE TABLE IF NOT EXISTS clock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        allocation_id INTEGER REFERENCES crew_allocations(id),
        event_type TEXT NOT NULL CHECK(event_type IN ('clock_in', 'clock_out')),
        event_time DATETIME NOT NULL DEFAULT (datetime('now')),
        latitude REAL,
        longitude REAL,
        accuracy REAL,
        address TEXT,
        notes TEXT,
        photo_path TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_clock_events_crew ON clock_events(crew_member_id, event_time);

      CREATE TABLE IF NOT EXISTS crew_availability (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        date DATE NOT NULL,
        status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'unavailable', 'preferred_off', 'leave')),
        shift_preference TEXT DEFAULT 'any' CHECK(shift_preference IN ('day', 'night', 'any')),
        notes TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        UNIQUE(crew_member_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_crew_availability_crew ON crew_availability(crew_member_id, date);

      CREATE TABLE IF NOT EXISTS docket_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        allocation_id INTEGER REFERENCES crew_allocations(id),
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        docket_type TEXT DEFAULT 'daily_docket' CHECK(docket_type IN ('daily_docket', 'delivery', 'completion')),
        docket_number TEXT,
        client_name TEXT,
        signature_data TEXT,
        signed_at DATETIME DEFAULT (datetime('now')),
        notes TEXT,
        photo_path TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_docket_signatures_crew ON docket_signatures(crew_member_id);

      CREATE TABLE IF NOT EXISTS safety_forms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        crew_member_id INTEGER NOT NULL REFERENCES crew_members(id),
        form_type TEXT NOT NULL CHECK(form_type IN ('prestart', 'take5', 'incident', 'hazard', 'equipment')),
        job_id INTEGER REFERENCES jobs(id),
        allocation_id INTEGER REFERENCES crew_allocations(id),
        data TEXT,
        status TEXT DEFAULT 'submitted' CHECK(status IN ('draft', 'submitted', 'reviewed')),
        submitted_at DATETIME DEFAULT (datetime('now')),
        reviewed_by_id INTEGER REFERENCES users(id),
        reviewed_at DATETIME,
        latitude REAL,
        longitude REAL,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_safety_forms_crew ON safety_forms(crew_member_id, form_type);

      CREATE TABLE IF NOT EXISTS employee_leave (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id),
        crew_member_id INTEGER REFERENCES crew_members(id),
        leave_type TEXT NOT NULL DEFAULT 'annual' CHECK(leave_type IN ('annual', 'sick', 'personal', 'unpaid', 'other')),
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        total_days REAL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
        reason TEXT,
        approved_by_id INTEGER REFERENCES users(id),
        approved_at DATETIME,
        notes TEXT,
        created_at DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_employee_leave_crew ON employee_leave(crew_member_id, status);
    `);

    // Add columns to crew_members
    const cols57cm = [
      "ALTER TABLE crew_members ADD COLUMN last_clock_event TEXT",
      "ALTER TABLE crew_members ADD COLUMN last_clock_time DATETIME",
      "ALTER TABLE crew_members ADD COLUMN onboarding_completed INTEGER DEFAULT 0",
    ];
    for (const sql of cols57cm) {
      try { db.exec(sql); } catch (e) { /* column may already exist */ }
    }

    // Add column to incidents
    try { db.exec("ALTER TABLE incidents ADD COLUMN reported_by_crew_id INTEGER REFERENCES crew_members(id)"); } catch (e) { /* column may already exist */ }

    recordMigration.run(57, 'Sprint 2 tables — clock events, availability, dockets, safety forms, leave');
    console.log('Migration 57 complete.');
  }

  // =============================================
  // Migration 58: Induction form enhancements — new fields
  // =============================================
  if (!isMigrationApplied.get(58)) {
    console.log('Running migration 58: Induction form enhancements');
    try {
      const newCols58 = [
        "ALTER TABLE induction_submissions ADD COLUMN tc_licence_date_of_issue TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN tc_licence_state TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN experience_years TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN experience_description TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN drivers_licence_back_photo TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_fund_name TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_fund_abn TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_usi TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN super_member_number TEXT DEFAULT ''",
        "ALTER TABLE induction_submissions ADD COLUMN has_insurance TEXT DEFAULT ''",
      ];
      for (const sql of newCols58) {
        try { db.exec(sql); } catch (e) { /* column likely exists */ }
      }
    } catch (e) {
      console.error('Migration 58 error:', e.message);
    }
    recordMigration.run(58, 'Induction form enhancements');
    console.log('Migration 58 complete.');
  }

  // =============================================
  // Migration 59: Clear all dummy/seed data
  // =============================================
  if (!isMigrationApplied.get(59)) {
    console.log('Running migration 59: Clear dummy/seed data');
    try {
      // Clear tables that only contain seed data
      const tablesToClear = [
        'traffic_plans',
        'crew_allocations',
        'timesheets',
        'cost_entries',
        'job_budgets',
        'incidents',
        'defects',
        'tasks',
        'equipment',
        'contacts',
        'compliance_items',
        'crew_members',
        'employees',
        'jobs',
        'clients',
      ];
      for (const table of tablesToClear) {
        try {
          db.exec(`DELETE FROM ${table}`);
          console.log(`  Cleared ${table}`);
        } catch (e) {
          // Table might not exist
          console.log(`  Skipped ${table}: ${e.message}`);
        }
      }
      // Reset auto-increment counters
      try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('traffic_plans','crew_allocations','timesheets','cost_entries','job_budgets','incidents','defects','tasks','equipment','contacts','compliance_items','crew_members','employees','jobs','clients')"); } catch(e) {}
    } catch (e) {
      console.error('Migration 59 error:', e.message);
    }
    recordMigration.run(59, 'Clear dummy/seed data');
    console.log('Migration 59 complete — all seed data cleared.');
  }

  console.log('All migrations checked/applied.');
}

// Separate function to seed demo data (called AFTER initial user/job seed)
function seedDemoData(db) {
  // Only run if migration 40 was applied and seed data hasn't been done yet
  const existingAllocs = db.prepare('SELECT COUNT(*) as c FROM crew_allocations').get().c;
  if (existingAllocs > 0) return; // Already seeded

  const jobCount = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  if (jobCount === 0) return; // No base seed data yet

  console.log('Seeding comprehensive demo data...');
  try {
      const today40 = new Date().toISOString().split('T')[0];
      const daysAgo40 = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
      const daysFromNow40 = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

      // --- 0. Seed budget data if migration 39 ran but found no jobs ---
      const existingBudgets = db.prepare('SELECT COUNT(*) as c FROM job_budgets').get().c;
      if (existingBudgets === 0) {
        const activeJobs = db.prepare("SELECT id, job_number, contract_value FROM jobs WHERE status IN ('active','won','on_hold') ORDER BY job_number").all();
        if (activeJobs.length > 0) {
          const insertBudget = db.prepare(`INSERT OR IGNORE INTO job_budgets (job_id, contract_value, budget_labour, budget_materials, budget_subcontractors, budget_equipment, budget_other, budget_contingency, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const insertCost = db.prepare(`INSERT INTO cost_entries (job_id, budget_id, category, description, amount, entry_date, invoice_ref, supplier, entered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
          const enteredBy = db.prepare("SELECT id FROM users WHERE role IN ('admin','finance') LIMIT 1").get()?.id || 1;
          const profiles = [
            { labourPct: 0.50, matPct: 0.08, subPct: 0.18, equipPct: 0.14, otherPct: 0.03, contPct: 0.07 },
            { labourPct: 0.52, matPct: 0.06, subPct: 0.20, equipPct: 0.12, otherPct: 0.04, contPct: 0.06 },
            { labourPct: 0.48, matPct: 0.10, subPct: 0.15, equipPct: 0.16, otherPct: 0.03, contPct: 0.08 },
            { labourPct: 0.55, matPct: 0.05, subPct: 0.17, equipPct: 0.13, otherPct: 0.04, contPct: 0.06 },
          ];
          const contractValues = [185000, 320000, 95000, 450000, 78000, 520000, 125000, 680000, 210000, 145000];
          const spendPcts = [0.38, 0.62, 0.78, 0.22, 0.45, 0.05, 0.55, 0.12, 0.35, 0.68];
          activeJobs.forEach((job, i) => {
            const contractVal = job.contract_value || contractValues[i % contractValues.length];
            const p = profiles[i % profiles.length];
            const totalBudget = contractVal * 0.92;
            insertBudget.run(job.id, contractVal,
              Math.round(totalBudget * p.labourPct), Math.round(totalBudget * p.matPct),
              Math.round(totalBudget * p.subPct), Math.round(totalBudget * p.equipPct),
              Math.round(totalBudget * p.otherPct), Math.round(totalBudget * p.contPct),
              'Auto-seeded budget');
            const budgetRow = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(job.id);
            if (!budgetRow) return;
            const spendPct = spendPcts[i % spendPcts.length];
            const totalSpend = totalBudget * spendPct;
            const costEntries = [
              { cat: 'labour', pct: 0.55, desc: 'Crew labour — weeks 1-' + Math.ceil(spendPct * 20), supplier: 'Internal', pre: 'LAB' },
              { cat: 'equipment', pct: 0.18, desc: 'TMA & equipment hire', supplier: 'T&S Fleet', pre: 'EQP' },
              { cat: 'materials', pct: 0.10, desc: 'Signage, cones & delineators', supplier: 'Traffix Devices', pre: 'MAT' },
              { cat: 'subcontractors', pct: 0.14, desc: 'Line marking & civil sub', supplier: 'Roadline Markings', pre: 'SUB' },
              { cat: 'other', pct: 0.03, desc: 'Permits & admin', supplier: 'Various', pre: 'OTH' },
            ];
            costEntries.forEach((ce, ci) => {
              const amount = Math.round(totalSpend * ce.pct);
              if (amount <= 0) return;
              insertCost.run(job.id, budgetRow.id, ce.cat, ce.desc, amount,
                daysAgo40(Math.max(1, Math.round((ci + 1) * 7 * spendPct))),
                ce.pre + '-' + job.job_number + '-' + String(ci + 1).padStart(3, '0'),
                ce.supplier, enteredBy);
            });
            if (!job.contract_value) {
              db.prepare('UPDATE jobs SET contract_value = ? WHERE id = ?').run(contractVal, job.id);
            }
          });
          console.log('  Seeded budgets for ' + activeJobs.length + ' jobs');
        }
      }

      // --- A. Crew allocations for today + recent days ---
      const existingAllocs = db.prepare('SELECT COUNT(*) as c FROM crew_allocations').get().c;
      if (existingAllocs === 0) {
        const insertAlloc = db.prepare(`
          INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, notes, allocated_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);
        // Today's allocations — 14 crew across 5 active jobs
        const todayAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Barrier install Section A'],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 4, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 2, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', 'Pending confirmation'],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'confirmed', 'Night works Main St'],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'confirmed', ''],
          [6, 8, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [6, 14, '19:00', '05:00', 'night', 'Spotter', 'confirmed', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Olympic Blvd works'],
          [9, 12, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [9, 13, '06:00', '14:30', 'day', 'Traffic Controller', 'allocated', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', 'Victoria Rd setup'],
          [10, 15, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [4, 23, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', 'Final inspection prep'],
        ];
        todayAllocs.forEach(a => insertAlloc.run(a[0], a[1], today40, a[2], a[3], a[4], a[5], a[6], a[7]));

        // Yesterday allocations
        const yAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', ''],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [1, 4, '06:00', '14:30', 'day', 'Traffic Controller', 'confirmed', ''],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'confirmed', ''],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'confirmed', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'confirmed', ''],
          [9, 12, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'confirmed', ''],
          [7, 6, '06:00', '16:00', 'day', 'Leading Hand', 'confirmed', 'Demob Coward St'],
          [7, 18, '06:00', '16:00', 'day', 'Traffic Controller', 'confirmed', ''],
        ];
        yAllocs.forEach(a => insertAlloc.run(a[0], a[1], daysAgo40(1), a[2], a[3], a[4], a[5], a[6], a[7]));

        // Tomorrow allocations
        const tAllocs = [
          [1, 1, '06:00', '14:30', 'day', 'Supervisor', 'allocated', ''],
          [1, 2, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', ''],
          [1, 3, '06:00', '14:30', 'day', 'Traffic Controller', 'allocated', ''],
          [6, 5, '19:00', '05:00', 'night', 'Supervisor', 'allocated', ''],
          [6, 7, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [6, 8, '19:00', '05:00', 'night', 'Traffic Controller', 'allocated', ''],
          [9, 11, '06:00', '14:30', 'day', 'Supervisor', 'allocated', ''],
          [10, 17, '06:00', '14:30', 'day', 'Leading Hand', 'allocated', ''],
        ];
        tAllocs.forEach(a => insertAlloc.run(a[0], a[1], daysFromNow40(1), a[2], a[3], a[4], a[5], a[6], a[7]));
      }

      // --- B. Equipment assignments (deployed to jobs) ---
      const existingEqAssign = db.prepare('SELECT COUNT(*) as c FROM equipment_assignments').get().c;
      if (existingEqAssign === 0) {
        const insertEqAssign = db.prepare(`
          INSERT INTO equipment_assignments (equipment_id, job_id, assigned_date, expected_return_date, actual_return_date, assigned_by_id, notes)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `);
        // Currently deployed (no actual_return_date)
        insertEqAssign.run(1, 1, daysAgo40(30), daysFromNow40(30), null, 'Arrow board for Canterbury Rd northbound');
        insertEqAssign.run(3, 9, daysAgo40(14), daysFromNow40(60), null, 'VMS Olympic Blvd detour info');
        insertEqAssign.run(5, 1, daysAgo40(30), daysFromNow40(30), null, 'Supervisor ute');
        insertEqAssign.run(6, 6, daysAgo40(10), daysFromNow40(45), null, 'Night works ute');
        insertEqAssign.run(7, 1, daysAgo40(30), daysFromNow40(30), null, 'Barriers Section A');
        insertEqAssign.run(9, 6, daysAgo40(10), daysFromNow40(45), null, 'Night works lighting');
        insertEqAssign.run(11, 9, daysAgo40(14), daysFromNow40(60), null, 'Traffic cones Olympic Blvd');
        insertEqAssign.run(14, 10, daysAgo40(7), daysFromNow40(90), null, 'Sign kit for Victoria Rd');
        // Previously deployed and returned
        insertEqAssign.run(2, 4, daysAgo40(60), daysAgo40(5), daysAgo40(5), 'Arrow board returned from Liverpool');
        insertEqAssign.run(8, 7, daysAgo40(45), daysAgo40(2), daysAgo40(2), 'Barriers returned from Mascot');
        insertEqAssign.run(12, 4, daysAgo40(60), daysAgo40(5), daysAgo40(5), 'Cone set B returned');
      }

      // --- C. Activity log entries (realistic recent activity) ---
      const existingActivity = db.prepare('SELECT COUNT(*) as c FROM activity_log').get().c;
      if (existingActivity < 5) {
        const insertActivity = db.prepare(`
          INSERT INTO activity_log (user_id, user_name, action, entity_type, entity_id, details, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const userNames = { 1: 'Admin User', 2: 'Sam Operations', 3: 'Alex Planning', 4: 'Pat Finance', 5: 'Jordan Accounts' };
        const activities = [
          [1, 'create', 'job', 12, 'Created job J-02462 — Acciona Wolli Creek', daysAgo40(0) + ' 09:15:00'],
          [2, 'update', 'allocation', null, 'Confirmed 14 crew allocations for today', daysAgo40(0) + ' 07:30:00'],
          [1, 'update', 'job', 7, 'Updated J-02457 progress to 90%', daysAgo40(0) + ' 08:45:00'],
          [3, 'create', 'compliance', 5, 'Submitted ROL Extension for J-02454', daysAgo40(1) + ' 14:20:00'],
          [5, 'update', 'task', 5, 'Marked "Chase overdue invoice #INV-4421" as in_progress', daysAgo40(1) + ' 10:00:00'],
          [2, 'update', 'incident', null, 'Closed incident INC-003 — near miss resolved', daysAgo40(1) + ' 16:30:00'],
          [1, 'create', 'budget', 1, 'Set budget for J-02451 — $185,000 contract', daysAgo40(2) + ' 11:00:00'],
          [3, 'update', 'compliance', 1, 'TMP approved for Canterbury Rd', daysAgo40(2) + ' 09:15:00'],
          [2, 'create', 'allocation', null, 'Created allocations for week of ' + daysAgo40(7), daysAgo40(3) + ' 15:45:00'],
          [5, 'create', 'cost_entry', null, 'Added $12,400 labour cost to J-02456', daysAgo40(3) + ' 13:20:00'],
          [1, 'update', 'job', 4, 'Changed J-02454 health to red — payment overdue', daysAgo40(4) + ' 10:30:00'],
          [2, 'create', 'timesheet', null, 'Submitted 8 timesheets for March 14', daysAgo40(4) + ' 17:00:00'],
          [3, 'create', 'plan', null, 'Created TMP for Church St closure', daysAgo40(5) + ' 11:30:00'],
          [1, 'update', 'crew', 16, 'Updated Michelle Harris licence expiry', daysAgo40(5) + ' 14:00:00'],
          [4, 'create', 'opportunity', null, 'New lead: Penrith Council road upgrade $340k', daysAgo40(6) + ' 09:00:00'],
          [1, 'create', 'job', 8, 'Created job J-02458 — John Holland Norwest', daysAgo40(7) + ' 10:15:00'],
          [2, 'update', 'equipment', 10, 'Flagged Lighting Tower #2 condition as poor', daysAgo40(8) + ' 08:30:00'],
          [5, 'create', 'invoice', null, 'Sent progress claim #2 to Fulton Hogan', daysAgo40(9) + ' 14:45:00'],
          [3, 'update', 'plan', null, 'ROL approved for Olympic Blvd night works', daysAgo40(10) + ' 16:00:00'],
          [1, 'update', 'settings', null, 'Updated defect severity dropdown options', daysAgo40(12) + ' 11:00:00'],
        ];
        activities.forEach(a => insertActivity.run(a[0], userNames[a[0]], a[1], a[2], a[3], a[4], a[5]));
      }

      // --- D. Update job last_update_date for active jobs (fix "missing weekly update") ---
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 1").run(daysAgo40(2));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 6").run(daysAgo40(3));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 7").run(daysAgo40(1));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 9").run(daysAgo40(4));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 10").run(daysAgo40(5));
      db.prepare("UPDATE jobs SET last_update_date = ? WHERE id = 11").run(daysAgo40(3));
      // Leave J-02454 (id=4) and J-02455 (id=5) with old dates to show realistic "missing update"

      // --- E. Seed CRM opportunities ---
      const existingOpps = db.prepare('SELECT COUNT(*) as c FROM opportunities').get().c;
      if (existingOpps === 0) {
        const insertOpp = db.prepare(`
          INSERT INTO opportunities (opportunity_number, title, client_id, owner_id, service_type, stage, probability, estimated_value, weighted_value, expected_close_date, source, region, notes, next_step, next_step_due_date, status, created_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertOpp.run('OPP-001', 'Penrith Council — Road Upgrade TCP', null, 4, 'traffic_management', 'proposal_pending', 60, 340000, 204000, daysFromNow40(30), 'referral', 'Western Sydney', 'Large road upgrade project. Council wants dedicated TCP for 6 months.', 'Follow up on proposal', daysFromNow40(5), 'open', 4);
        insertOpp.run('OPP-002', 'Laing O\'Rourke — M4 Widening', null, 4, 'traffic_management', 'qualified', 40, 580000, 232000, daysFromNow40(60), 'tender_portal', 'Western Sydney', 'Tier 1 project. Long-term opportunity if we get in.', 'Submit EOI', daysFromNow40(10), 'open', 4);
        insertOpp.run('OPP-003', 'Ausgrid — Cable Replacement', null, 4, 'traffic_management', 'quote_sent', 75, 125000, 93750, daysFromNow40(14), 'existing_client', 'Inner West', 'Follow-on from Penrith job. Good relationship with PM.', 'Chase quote response', daysFromNow40(3), 'open', 4);
        insertOpp.run('OPP-004', 'City of Sydney — Bike Lane Install', null, 4, 'traffic_management', 'meeting_booked', 30, 210000, 63000, daysFromNow40(45), 'website', 'CBD', 'Green infrastructure project. Needs night works capability.', 'Attend site meeting', daysFromNow40(7), 'open', 4);
        insertOpp.run('OPP-005', 'Downer EDI — Intersection Upgrade', null, 4, 'traffic_management', 'negotiation', 80, 195000, 156000, daysFromNow40(7), 'existing_client', 'Northern Sydney', 'Almost closed. Waiting on final PO.', 'Follow up PO', daysFromNow40(2), 'open', 4);
        insertOpp.run('OPP-006', 'Fulton Hogan — Night Works Package', 5, 4, 'traffic_management', 'won', 100, 320000, 320000, daysAgo40(10), 'existing_client', 'Western Sydney', 'Converted to J-02456', 'Mobilise crew', null, 'won', 4);
        insertOpp.run('OPP-007', 'Ventia — Water Main Repair', null, 4, 'traffic_management', 'new_lead', 15, 85000, 12750, daysFromNow40(90), 'cold_call', 'South West Sydney', 'Initial enquiry. Small job but good foot in the door.', 'Call back to qualify', daysFromNow40(5), 'open', 4);
      }

      // --- F. Seed CRM activities ---
      const existingCrmAct = db.prepare('SELECT COUNT(*) as c FROM crm_activities').get().c;
      if (existingCrmAct === 0) {
        const insertCrmAct = db.prepare(`
          INSERT INTO crm_activities (activity_type, subject, notes, outcome, opportunity_id, owner_id, activity_date, is_completed, created_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertCrmAct.run('call', 'Follow up with Penrith Council', 'Discussed project timeline and crew requirements', 'Positive — submitting proposal this week', 1, 4, daysAgo40(3) + ' 10:00:00', 1, 4);
        insertCrmAct.run('meeting', 'Site visit — M4 Widening', 'Walked site with Laing PM. Assessed TCP requirements.', 'Good fit for our capability. Large mobilisation needed.', 2, 4, daysAgo40(5) + ' 14:00:00', 1, 4);
        insertCrmAct.run('email', 'Quote sent to Ausgrid', 'Sent formal quote for cable replacement TCP', 'Awaiting response', 3, 4, daysAgo40(2) + ' 09:30:00', 1, 4);
        insertCrmAct.run('call', 'Intro call — City of Sydney', 'Discussed bike lane project scope and our night works experience', 'Meeting booked for next week', 4, 4, daysAgo40(7) + ' 11:00:00', 1, 4);
        insertCrmAct.run('meeting', 'Negotiation — Downer EDI intersection', 'Final rates discussion. Agreed terms.', 'PO expected this week', 5, 4, daysAgo40(1) + ' 15:00:00', 1, 4);
      }

      // --- G. Update Test Worker (crew_member id=1) with fuller data ---
      try {
        db.prepare(`UPDATE crew_members SET
          emergency_contact_name = 'Jane Smith',
          emergency_contact_phone = '0402 111 222'
          WHERE id = 1 AND (emergency_contact_name IS NULL OR emergency_contact_name = '')
        `).run();
      } catch (e) { /* columns may not exist */ }

      // --- H. Dismiss onboarding for admin user (demo should look production-ready) ---
      try {
        // Add preferences column if missing
        try { db.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'"); } catch (e) { /* already exists */ }
        db.prepare("UPDATE users SET preferences = ? WHERE id = 1").run(JSON.stringify({ onboarding_dismissed: true }));
      } catch (e) { /* ignore */ }

      // --- I. Add more project updates so "missing weekly update" count is realistic ---
      try {
        const insertUpdate40 = db.prepare(`
          INSERT OR IGNORE INTO project_updates (job_id, week_ending, summary, milestones, issues_risks, blockers, submitted_by_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        insertUpdate40.run(6, daysAgo40(3), 'Night works progressing well. Lane closure setup efficient. No incidents.', 'Main St section 1 complete. Section 2 starting.', 'Noise complaints from residents — adjusted generator placement.', '', 2);
        insertUpdate40.run(7, daysAgo40(1), 'Demobilisation 80% complete. Final equipment collection scheduled.', 'All barriers removed. Signs collected.', 'None — clean finish expected.', '', 2);
        insertUpdate40.run(9, daysAgo40(4), 'Olympic Blvd works on track. ROL approved. Night crew performing well.', 'Stage 1 traffic switch complete.', 'Wet weather risk next week.', '', 3);
        insertUpdate40.run(10, daysAgo40(5), 'Victoria Rd setup progressing. Crew familiarised with TGS.', 'Initial setup 25% complete.', 'Heavy traffic volumes requiring additional spotter.', '', 2);
        insertUpdate40.run(11, daysAgo40(3), 'Campbelltown job approaching deadline. Progress claim dispute ongoing.', 'Barrier install 70% done.', 'Payment delay from Georgiou. Accounts following up.', 'Cannot order additional materials until payment received.', 1);
      } catch (e) { /* ignore duplicates */ }

      console.log('Demo data seeded successfully.');
    } catch (e) {
      console.error('Demo data seed error:', e.message);
    }
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
      role TEXT NOT NULL CHECK(role IN ('admin','operations','planning','finance','hr','sales','management','marketing','accounts')),
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
    insertUser.run('suhail.a', bcrypt.hashSync('Suhail123', 12), 'Suhail Ahmed', 'suhail@tstc.com.au', 'admin');
    insertUser.run('saadat', bcrypt.hashSync('TandS2026.', 12), 'Saadat', 'saadat@tstc.com.au', 'admin');
    insertUser.run('savanah', bcrypt.hashSync('Savanah123', 12), 'Savanah', 'savanah@tstc.com.au', 'admin');
    insertUser.run('taj', bcrypt.hashSync('Taj123', 12), 'Taj', 'taj@tstc.com.au', 'admin');
    insertUser.run('ops_user', bcrypt.hashSync('password', 12), 'Sam Operations', 'sam@tstraffic.com.au', 'operations');
    insertUser.run('planning_user', bcrypt.hashSync('password', 12), 'Alex Planning', 'alex@tstraffic.com.au', 'planning');
    insertUser.run('finance_user', bcrypt.hashSync('password', 12), 'Pat Finance', 'pat@tstraffic.com.au', 'finance');
    insertUser.run('accounts_user', bcrypt.hashSync('password', 12), 'Jordan Accounts', 'jordan@tstraffic.com.au', 'finance');

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

    // ── Additional jobs (7 more to reach 12 total) ──
    insertJob.run('J-02456', 'J-02456 | Fulton Hogan | Blacktown | 2026-03-15', 'Fulton Hogan', '5 Main St', 'Blacktown', 'active', 'delivery', 60, '2026-03-15', '2026-08-20', 1, 2, 3, 4, 5, 'green', 'on_track', '2026-03-10');
    insertJob.run('J-02457', 'J-02457 | CPB Contractors | Mascot | 2026-01-20', 'CPB Contractors', '200 Coward St', 'Mascot', 'active', 'delivery', 90, '2026-01-20', '2026-03-30', 1, 2, 3, 4, 5, 'green', 'on_track', '2026-03-15');
    insertJob.run('J-02458', 'J-02458 | John Holland | Norwest | 2026-04-01', 'John Holland', '10 Lexington Dr', 'Norwest', 'won', 'prestart', 5, '2026-04-01', '2026-10-15', 1, 2, 3, 4, 5, 'green', 'na', null);
    insertJob.run('J-02459', 'J-02459 | Transport for NSW | Homebush | 2026-02-10', 'Transport for NSW', '1 Olympic Blvd', 'Homebush', 'active', 'delivery', 55, '2026-02-10', '2026-07-15', 1, 2, 3, 4, 5, 'amber', 'on_track', '2026-03-12');
    insertJob.run('J-02460', 'J-02460 | Downer EDI | Ryde | 2026-03-01', 'Downer EDI', '45 Victoria Rd', 'Ryde', 'active', 'delivery', 25, '2026-03-01', '2026-09-30', 1, 2, 3, 4, 5, 'green', 'on_track', '2026-03-14');
    insertJob.run('J-02461', 'J-02461 | Georgiou Group | Campbelltown | 2026-02-20', 'Georgiou Group', '80 Queen St', 'Campbelltown', 'active', 'delivery', 70, '2026-02-20', '2026-06-15', 1, 2, 3, 4, 5, 'red', 'overdue', '2026-03-01');
    insertJob.run('J-02462', 'J-02462 | Acciona | Wolli Creek | 2026-03-20', 'Acciona', '15 Arncliffe St', 'Wolli Creek', 'lead', 'tender', 0, '2026-03-20', '2026-12-31', 1, 2, 3, 4, 5, 'green', 'na', null);

    // ── Crew members (25 people) ──
    const insertCrew = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, role, phone, email, licence_type, licence_expiry, induction_date, active, hourly_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCrew.run('John Smith', 'EMP-001', 'supervisor', '0412 345 678', 'john.smith@tstraffic.com.au', 'C', '2027-06-15', '2024-01-10', 1, 65);
    insertCrew.run('Sarah Johnson', 'EMP-002', 'leading_hand', '0413 456 789', 'sarah.j@tstraffic.com.au', 'C', '2026-11-20', '2024-02-15', 1, 55);
    insertCrew.run('Mike Chen', 'EMP-003', 'traffic_controller', '0414 567 890', 'mike.c@tstraffic.com.au', 'C', '2026-08-30', '2024-03-01', 1, 45);
    insertCrew.run('Emma Wilson', 'EMP-004', 'traffic_controller', '0415 678 901', 'emma.w@tstraffic.com.au', 'C', '2027-01-15', '2024-01-20', 1, 45);
    insertCrew.run('David Brown', 'EMP-005', 'supervisor', '0416 789 012', 'david.b@tstraffic.com.au', 'HR', '2027-03-10', '2023-11-05', 1, 65);
    insertCrew.run('Lisa Nguyen', 'EMP-006', 'leading_hand', '0417 890 123', 'lisa.n@tstraffic.com.au', 'C', '2026-05-20', '2024-04-10', 1, 55);
    insertCrew.run('James Taylor', 'EMP-007', 'traffic_controller', '0418 901 234', 'james.t@tstraffic.com.au', 'C', '2026-09-15', '2024-05-01', 1, 45);
    insertCrew.run('Amy Patel', 'EMP-008', 'traffic_controller', '0419 012 345', 'amy.p@tstraffic.com.au', 'C', '2027-02-28', '2024-06-15', 1, 45);
    insertCrew.run('Ryan O\'Brien', 'EMP-009', 'pilot_vehicle', '0420 123 456', 'ryan.o@tstraffic.com.au', 'HR', '2026-12-01', '2024-02-20', 1, 50);
    insertCrew.run('Jessica Martinez', 'EMP-010', 'traffic_controller', '0421 234 567', 'jess.m@tstraffic.com.au', 'C', '2026-04-10', '2024-07-01', 1, 45);
    insertCrew.run('Tom Anderson', 'EMP-011', 'supervisor', '0422 345 678', 'tom.a@tstraffic.com.au', 'HR', '2027-05-20', '2023-09-15', 1, 65);
    insertCrew.run('Rachel Kim', 'EMP-012', 'leading_hand', '0423 456 789', 'rachel.k@tstraffic.com.au', 'C', '2026-07-15', '2024-01-05', 1, 55);
    insertCrew.run('Steve Murray', 'EMP-013', 'traffic_controller', '0424 567 890', 'steve.m@tstraffic.com.au', 'C', '2026-10-30', '2024-08-01', 1, 45);
    insertCrew.run('Karen White', 'EMP-014', 'spotter', '0425 678 901', 'karen.w@tstraffic.com.au', 'C', '2027-04-15', '2024-03-20', 1, 48);
    insertCrew.run('Daniel Lee', 'EMP-015', 'traffic_controller', '0426 789 012', 'daniel.l@tstraffic.com.au', 'C', '2026-06-25', '2024-09-01', 1, 45);
    insertCrew.run('Michelle Harris', 'EMP-016', 'traffic_controller', '0427 890 123', 'michelle.h@tstraffic.com.au', 'C', '2026-03-25', '2024-04-15', 1, 45);
    insertCrew.run('Chris Thompson', 'EMP-017', 'leading_hand', '0428 901 234', 'chris.t@tstraffic.com.au', 'C', '2027-01-30', '2024-05-10', 1, 55);
    insertCrew.run('Natalie Cooper', 'EMP-018', 'traffic_controller', '0429 012 345', 'nat.c@tstraffic.com.au', 'C', '2026-08-10', '2024-10-01', 1, 45);
    insertCrew.run('Ben Walker', 'EMP-019', 'pilot_vehicle', '0430 123 456', 'ben.w@tstraffic.com.au', 'HR', '2026-11-05', '2024-06-20', 1, 50);
    insertCrew.run('Sophie Young', 'EMP-020', 'traffic_controller', '0431 234 567', 'sophie.y@tstraffic.com.au', 'C', '2027-03-15', '2024-07-15', 1, 45);
    insertCrew.run('Mark Phillips', 'EMP-021', 'labourer', '0432 345 678', 'mark.p@tstraffic.com.au', 'C', '2026-09-20', '2024-08-10', 1, 40);
    insertCrew.run('Laura Scott', 'EMP-022', 'traffic_controller', '0433 456 789', 'laura.s@tstraffic.com.au', 'C', '2026-04-30', '2024-11-01', 1, 45);
    insertCrew.run('Peter Hall', 'EMP-023', 'supervisor', '0434 567 890', 'peter.h@tstraffic.com.au', 'HR', '2027-02-10', '2023-12-01', 1, 65);
    insertCrew.run('Angela Davis', 'EMP-024', 'traffic_controller', '0435 678 901', 'angela.d@tstraffic.com.au', 'C', '2026-05-15', '2024-09-15', 1, 45);
    insertCrew.run('Tony Romano', 'EMP-025', 'leading_hand', '0436 789 012', 'tony.r@tstraffic.com.au', 'C', '2026-12-20', '2024-02-01', 1, 55);

    // ── Equipment (15 items) ──
    const insertEquipment = db.prepare(`
      INSERT INTO equipment (asset_number, name, category, description, serial_number, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, notes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEquipment.run('EQ-001', 'Arrow Board Trailer #1', 'arrow_board', '15-lamp LED arrow board on single-axle trailer', 'AB-2023-001', '2023-06-15', 8500, 'good', 'Bankstown Depot', '2026-06-15', 90, 'Annual rego due July', 1);
    insertEquipment.run('EQ-002', 'Arrow Board Trailer #2', 'arrow_board', '15-lamp LED arrow board on single-axle trailer', 'AB-2023-002', '2023-06-15', 8500, 'good', 'Bankstown Depot', '2026-04-20', 90, '', 1);
    insertEquipment.run('EQ-003', 'VMS Board - Large', 'vms', 'Solar-powered variable message sign 2400x1200', 'VMS-2024-001', '2024-02-01', 22000, 'good', 'Parramatta Yard', '2026-05-01', 90, 'New battery installed Feb 2026', 1);
    insertEquipment.run('EQ-004', 'VMS Board - Small', 'vms', 'Trailer-mounted VMS 1200x600', 'VMS-2024-002', '2024-03-10', 15000, 'fair', 'Bankstown Depot', '2026-03-30', 90, 'Screen flickering - monitor', 1);
    insertEquipment.run('EQ-005', 'Traffic Ute #1', 'vehicle', '2024 Toyota Hilux SR5 dual cab, white', 'VEH-HIL-001', '2024-01-20', 58000, 'good', 'Bankstown Depot', '2026-07-20', 180, 'Fleet #T&S-U01', 1);
    insertEquipment.run('EQ-006', 'Traffic Ute #2', 'vehicle', '2024 Toyota Hilux SR dual cab, white', 'VEH-HIL-002', '2024-04-15', 52000, 'good', 'Parramatta Yard', '2026-10-15', 180, 'Fleet #T&S-U02', 1);
    insertEquipment.run('EQ-007', 'Barrier Trailer #1', 'barrier', 'Water-filled barrier set (40 units) on flat-top trailer', 'BAR-2023-001', '2023-09-01', 12000, 'good', 'Bankstown Depot', '2026-09-01', 180, '', 1);
    insertEquipment.run('EQ-008', 'Barrier Trailer #2', 'barrier', 'Water-filled barrier set (40 units) on flat-top trailer', 'BAR-2023-002', '2023-09-01', 12000, 'fair', 'Liverpool Yard', '2026-04-10', 180, '3 barriers cracked, replacement ordered', 1);
    insertEquipment.run('EQ-009', 'Lighting Tower #1', 'lighting', 'Diesel lighting tower 4-head LED', 'LT-2024-001', '2024-05-20', 18000, 'good', 'Bankstown Depot', '2026-05-20', 90, '', 1);
    insertEquipment.run('EQ-010', 'Lighting Tower #2', 'lighting', 'Diesel lighting tower 4-head LED', 'LT-2024-002', '2024-05-20', 18000, 'poor', 'Bankstown Depot', '2026-03-20', 90, 'Generator needs service', 1);
    insertEquipment.run('EQ-011', 'Cone Set A (200)', 'cone', '200x 700mm reflective traffic cones', 'CONE-2024-A', '2024-01-10', 3000, 'good', 'Bankstown Depot', '2026-07-10', 180, '', 1);
    insertEquipment.run('EQ-012', 'Cone Set B (200)', 'cone', '200x 700mm reflective traffic cones', 'CONE-2024-B', '2024-01-10', 3000, 'fair', 'Parramatta Yard', '2026-07-10', 180, '~30 cones damaged', 1);
    insertEquipment.run('EQ-013', 'Delineator Set (100)', 'delineator', '100x T-top delineators with bases', 'DEL-2024-001', '2024-06-01', 2500, 'good', 'Bankstown Depot', '2026-12-01', 180, '', 1);
    insertEquipment.run('EQ-014', 'Sign Kit - Complete', 'sign', 'Full TC sign kit - 120 signs, stands, sandbags', 'SIGN-2023-001', '2023-08-15', 6000, 'good', 'Bankstown Depot', '2026-08-15', 180, '', 1);
    insertEquipment.run('EQ-015', 'Speed Radar Trailer', 'other', 'Solar-powered speed advisory display trailer', 'SPD-2025-001', '2025-11-01', 14000, 'new', 'Parramatta Yard', '2026-11-01', 90, 'Purchased for TfNSW project', 1);

    // ── Additional tasks (5 more to reach 10 total) ──
    insertTask.run(6, 'ops', 'Set up night works lane closure', 'Establish contra-flow on Main St between 8pm-5am', 2, '2026-03-20', 'not_started', 'medium');
    insertTask.run(7, 'ops', 'Complete site demobilisation', 'Remove all barriers, signs, and equipment from Coward St', 2, '2026-03-25', 'in_progress', 'high');
    insertTask.run(9, 'planning', 'Submit ROL application to TfNSW', 'Road Occupancy Licence for Olympic Blvd night works', 3, '2026-03-18', 'in_progress', 'high');
    insertTask.run(10, 'ops', 'Conduct crew toolbox talk', 'Weekly safety briefing for Victoria Rd crew', 2, '2026-03-17', 'not_started', 'medium');
    insertTask.run(11, 'accounts', 'Process progress claim #3', 'Georgiou Group progress claim for February works', 5, '2026-03-15', 'not_started', 'high');

    // ── Clients / Subcontractors / Suppliers ──
    const insertClient = db.prepare(`
      INSERT INTO clients (company_name, abn, primary_contact_name, primary_contact_phone, primary_contact_email, address, billing_address, payment_terms, notes, active, company_type, trade_specialty, insurance_expiry, insurance_policy, product_categories, account_number, website, approved, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Clients
    insertClient.run('ABC Civil', '51 234 567 890', 'Greg Thompson', '0400 111 222', 'greg.t@abccivil.com.au', '100 George St, Sydney NSW 2000', 'PO Box 100, Sydney NSW 2001', '30 days', 'Major civil contractor, long-term client', 1, 'client', '', null, '', '', '', 'www.abccivil.com.au', 1, 4);
    insertClient.run('RMS NSW', '20 345 678 901', 'Linda Park', '0400 222 333', 'linda.park@transport.nsw.gov.au', '20 Lee St, Chippendale NSW 2008', '', 'EOM+30', 'Government - Transport for NSW', 1, 'client', '', null, '', '', '', 'www.transport.nsw.gov.au', 1, 5);
    insertClient.run('Lendlease', '40 456 789 012', 'Rebecca Walsh', '0400 888 999', 'r.walsh@lendlease.com', '30 The Bond, Millers Point NSW 2000', 'Level 14, 30 The Bond, Millers Point NSW 2000', '45 days', 'Tier 1 builder', 1, 'client', '', null, '', '', '', 'www.lendlease.com', 1, 4);
    insertClient.run('Sydney Water', '49 776 225 038', 'Fiona Clarke', '0400 444 555', 'fiona.c@sydneywater.com.au', '1 Smith St, Parramatta NSW 2150', '', '30 days', '', 1, 'client', '', null, '', '', '', 'www.sydneywater.com.au', 1, 3);
    // Subcontractors
    insertClient.run('Sydney Line Marking', '33 111 222 333', 'Dave Russo', '0411 222 333', 'dave@sydneylinemarking.com.au', '18 Industrial Ave, Bankstown NSW 2200', '', '14 days', 'Reliable line marking subbie. Available most nights.', 1, 'subcontractor', 'line_marking', '2026-09-30', 'QBE-PL-445566', '', '', 'www.sydneylinemarking.com.au', 1, 4);
    insertClient.run('PowerGrid Electrical', '44 222 333 444', 'Maria Santos', '0422 333 444', 'maria@powergridelectrical.com.au', '7 Sparks Rd, Penrith NSW 2750', '', '14 days', 'Licensed electrician for street lighting and signal work', 1, 'subcontractor', 'electrical', '2027-01-15', 'AIG-PL-778899', '', '', 'www.powergridelectrical.com.au', 1, 5);
    insertClient.run('Metro Fencing Solutions', '55 333 444 555', 'Trent O\'Neill', '0433 444 555', 'trent@metrofencing.com.au', '22 Boundary St, Granville NSW 2142', '', '7 days', 'Temp fencing and hoarding. Quick turnaround.', 1, 'subcontractor', 'fencing', '2026-06-15', 'ZURICH-PL-112233', '', '', '', 1, 3);
    // Suppliers
    insertClient.run('Barrier Systems Australia', '66 444 555 666', 'Kim Tran', '0444 555 666', 'kim@barriersystems.com.au', '5 Factory Rd, Wetherill Park NSW 2164', 'PO Box 55, Wetherill Park NSW 2164', '30 days', 'Plastic and concrete barriers. Water-fill available.', 1, 'supplier', '', null, '', 'barriers,delineators', 'BSA-2200', 'www.barriersystems.com.au', 1, 4);
    insertClient.run('Kennards Hire', '22 555 666 777', 'Account Team', '13 15 64', 'hire@kennards.com.au', '126 Silverwater Rd, Silverwater NSW 2128', '', 'EOM', 'General equipment hire. Use national account rate.', 1, 'supplier', '', null, '', 'lighting,vehicles,other', 'KH-NAT-5540', 'www.kennards.com.au', 1, 4);
    insertClient.run('SignPac', '77 666 777 888', 'Ross Brennan', '0455 666 777', 'ross@signpac.com.au', '40 Industry Rd, Padstow NSW 2211', '', '14 days', 'Custom and standard traffic signs. 48hr turnaround on stock items.', 1, 'supplier', '', null, '', 'signs,cones,delineators', 'SP-1180', 'www.signpac.com.au', 1, 5);

    // Link jobs to clients
    try {
      db.exec("UPDATE jobs SET client_id = 1 WHERE client = 'ABC Civil'");
      db.exec("UPDATE jobs SET client_id = 2 WHERE client = 'RMS NSW'");
      db.exec("UPDATE jobs SET client_id = 3 WHERE client = 'Lendlease'");
      db.exec("UPDATE jobs SET client_id = 4 WHERE client = 'Sydney Water'");
    } catch (e) { /* client_id column may not exist yet */ }

    // ── Contacts (5) ──
    const insertContact = db.prepare(`
      INSERT INTO client_contacts (job_id, contact_type, company, full_name, position, phone, email, notes, is_primary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertContact.run(1, 'client', 'ABC Civil', 'Greg Thompson', 'Project Manager', '0400 111 222', 'greg.t@abccivil.com.au', 'Primary contact for Bankstown project', 1);
    insertContact.run(2, 'rms', 'Transport for NSW', 'Linda Park', 'Network Coordinator', '0400 222 333', 'linda.park@transport.nsw.gov.au', 'Handles ROL approvals for Parramatta area', 1);
    insertContact.run(1, 'council', 'Canterbury-Bankstown Council', 'Ahmed Hassan', 'Traffic Engineer', '0400 333 444', 'ahmed.h@cbcity.nsw.gov.au', 'Approves TMPs for Canterbury Rd precinct', 0);
    insertContact.run(4, 'client', 'Sydney Water', 'Fiona Clarke', 'Site Supervisor', '0400 444 555', 'fiona.c@sydneywater.com.au', 'Day-to-day site contact for Liverpool', 1);
    insertContact.run(6, 'subcontractor', 'Fulton Hogan', 'Brett Williams', 'Foreman', '0400 555 666', 'brett.w@fultonhogan.com.au', 'Night works coordination', 0);

    // ── Timesheets (10 entries) ──
    const insertTimesheet = db.prepare(`
      INSERT INTO timesheets (job_id, crew_member_id, work_date, start_time, end_time, break_minutes, total_hours, shift_type, role_on_site, approved, approved_by_id, notes, submitted_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTimesheet.run(1, 1, '2026-03-14', '06:00', '14:30', 30, 8.0, 'day', 'Supervisor', 1, 1, 'Barrier install Section A', 1);
    insertTimesheet.run(1, 3, '2026-03-14', '06:00', '14:30', 30, 8.0, 'day', 'Traffic Controller', 1, 1, 'Barrier install Section A', 1);
    insertTimesheet.run(1, 4, '2026-03-14', '06:00', '14:30', 30, 8.0, 'day', 'Traffic Controller', 1, 1, 'Barrier install Section A', 1);
    insertTimesheet.run(1, 2, '2026-03-15', '06:00', '16:00', 30, 9.5, 'day', 'Leading Hand', 0, null, 'Extended shift - barrier completion', 1);
    insertTimesheet.run(1, 3, '2026-03-15', '06:00', '16:00', 30, 9.5, 'day', 'Traffic Controller', 0, null, 'Extended shift', 1);
    insertTimesheet.run(6, 5, '2026-03-14', '19:00', '05:00', 30, 9.5, 'night', 'Supervisor', 1, 1, 'Night works - lane closure Main St', 1);
    insertTimesheet.run(6, 7, '2026-03-14', '19:00', '05:00', 30, 9.5, 'night', 'Traffic Controller', 1, 1, 'Night works', 1);
    insertTimesheet.run(6, 8, '2026-03-14', '19:00', '05:00', 30, 9.5, 'night', 'Traffic Controller', 0, null, 'Night works - pending approval', 1);
    insertTimesheet.run(4, 11, '2026-03-13', '06:30', '15:00', 30, 8.0, 'day', 'Supervisor', 1, 1, 'Final inspection prep', 1);
    insertTimesheet.run(4, 13, '2026-03-13', '06:30', '15:00', 30, 8.0, 'day', 'Traffic Controller', 0, null, 'Final inspection prep - pending', 1);

    // ── Incidents (3) ──
    const insertIncident = db.prepare(`
      INSERT INTO incidents (job_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, persons_involved, immediate_actions, root_cause, investigation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertIncident.run(1, 'INC-0001', 'near_miss', 'medium', 'Vehicle entered work zone', 'Private vehicle ignored signage and entered active work zone on Canterbury Rd. No injuries. Crew members had to move quickly to avoid contact.', '12 Canterbury Rd, Bankstown', '2026-03-10', '10:30', 1, 'Mike Chen (EMP-003), Emma Wilson (EMP-004)', 'Work stopped immediately. Additional signage deployed. RMS notified.', 'Inadequate advance warning signage during peak hour', 'resolved');
    insertIncident.run(4, 'INC-0002', 'injury', 'high', 'Crew member twisted ankle', 'Steve Murray stepped in pothole while repositioning barriers at Liverpool site. Ankle swelling observed. First aid administered on site.', '45 Macquarie St, Liverpool', '2026-03-12', '14:15', 1, 'Steve Murray (EMP-013)', 'First aid applied. Worker sent home. Incident area cordoned. Site hazard assessment completed.', 'Uneven ground surface not identified in pre-start', 'investigating');
    insertIncident.run(6, 'INC-0003', 'hazard', 'low', 'Damaged road surface near barrier line', 'Pothole developing at edge of barrier line on Main St near work zone entry point. Could worsen with heavy vehicle traffic.', '5 Main St, Blacktown', '2026-03-15', '08:00', 2, '', 'Area marked with cones. Council notified for repair.', '', 'reported');

    // ── Defects (5) ──
    const insertDefect = db.prepare(`
      INSERT INTO defects (job_id, defect_number, title, description, location, severity, status, reported_by_id, assigned_to_id, reported_date, target_close_date, rectification_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertDefect.run(1, 'DEF-0001', 'Cracked barrier section B12', 'Water-filled barrier unit B12 has visible crack along top edge. Leaking slowly.', 'Canterbury Rd northbound, Section B', 'moderate', 'rectification', 1, 2, '2026-03-08', '2026-03-20', 'Replacement barrier ordered. ETA 18 March.');
    insertDefect.run(1, 'DEF-0002', 'Faded road marking at detour entry', 'Temporary road marking at detour entry point is worn and hard to see at night.', 'Canterbury Rd / Side St intersection', 'minor', 'open', 2, 3, '2026-03-12', '2026-03-22', '');
    insertDefect.run(4, 'DEF-0003', 'Missing delineator posts - westbound', '4 delineator posts missing from westbound approach. Likely knocked over by trucks.', 'Macquarie St, Liverpool - westbound', 'major', 'investigating', 1, 2, '2026-03-11', '2026-03-15', 'Replacement delineators sourced. Install scheduled for 15 March.');
    insertDefect.run(6, 'DEF-0004', 'Arrow board lamp failure', 'Arrow board trailer EQ-002 has 3 lamps not functioning. Reduces visibility.', 'Main St, Blacktown - night works zone', 'moderate', 'open', 2, 2, '2026-03-14', '2026-03-18', '');
    insertDefect.run(9, 'DEF-0005', 'Damaged VMS screen', 'VMS board showing display artifacts on lower-right quadrant. Intermittent issue.', 'Olympic Blvd approach, Homebush', 'minor', 'deferred', 1, 3, '2026-03-05', '2026-04-05', 'Deferred to next scheduled maintenance window. Not impacting readability.');

    // ── Additional compliance items (5 more) ──
    insertCompliance.run(6, 'road_occupancy', 'ROL - Main St Night Works', 'Transport for NSW', 2, '2026-03-18', 'submitted');
    insertCompliance.run(9, 'tmp_approval', 'TMP - Olympic Blvd Detour', 'City of Parramatta Council', 3, '2026-03-25', 'not_started');
    insertCompliance.run(10, 'swms_review', 'SWMS - Victoria Rd Median Works', '', 2, '2026-03-20', 'approved');
    insertCompliance.run(11, 'council_permit', 'Road Opening Permit - Queen St', 'Campbelltown City Council', 3, '2026-03-10', 'submitted');
    insertCompliance.run(7, 'insurance', 'PI Certificate - CPB Project', 'QBE Insurance', 5, '2026-04-01', 'approved');

    // ── Additional project updates (3 more) ──
    insertUpdate.run(6, '2026-03-14', 'Night works progressing well. Lane closure setup completed ahead of schedule. Minor issue with arrow board lamps resolved.', 'Lane closure established. First 200m of asphalt resurfacing complete.', 'Arrow board EQ-002 had lamp failures. Backup deployed.', '', 1);
    insertUpdate.run(9, '2026-03-14', 'TfNSW project on track. ROL application submitted, awaiting approval. Crew briefed on traffic staging.', 'ROL application submitted to TfNSW. Crew inductions completed.', 'ROL approval taking longer than expected. Escalated to regional coordinator.', 'Cannot commence night works until ROL is approved.', 1);
    insertUpdate.run(11, '2026-03-07', 'Campbelltown project facing payment delays. Road opening permit submitted to council. Crew allocated for next 2 weeks.', 'Excavation 70% complete. Permit application lodged.', 'Client progress claim #2 still unpaid (45 days). Escalated to accounts.', 'Cannot order materials for final stage until payment received.', 1);

    console.log('Database seeded with sample data.');

    // Seed comprehensive demo data (allocations, equipment assignments, activity log, CRM, etc.)
    seedDemoData(db);
  }

  // Ensure key users always exist (survives DB resets)
  const ensureUser = db.prepare(`
    INSERT OR IGNORE INTO users (username, password_hash, full_name, email, role) VALUES (?, ?, ?, ?, ?)
  `);
  const ensureUsers = [
    ['suhail.a', 'Suhail123', 'Suhail Ahmed', 'suhail@tstc.com.au', 'admin'],
    ['saadat', 'TandS2026.', 'Saadat', 'saadat@tstc.com.au', 'admin'],
    ['savanah', 'Savanah123', 'Savanah', 'savanah@tstc.com.au', 'admin'],
    ['taj', 'Taj123', 'Taj', 'taj@tstc.com.au', 'admin'],
  ];
  for (const [uname, pwd, fullName, email, role] of ensureUsers) {
    if (!db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) {
      ensureUser.run(uname, bcrypt.hashSync(pwd, 12), fullName, email, role);
      console.log(`Created ${uname} user.`);
    }
  }

  db.close();
  console.log('Database initialized at', DB_PATH);
}

module.exports = { initializeDatabase, DB_PATH };
