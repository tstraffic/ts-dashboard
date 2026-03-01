const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'tstraffic.db');

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
      role TEXT NOT NULL CHECK(role IN ('management','operations','planning','marketing','accounts')),
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
      division TEXT NOT NULL CHECK(division IN ('ops','planning','marketing','accounts','management')),
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

  // Seed default admin user if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const hash = bcrypt.hashSync('admin123', 12);
    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role) VALUES (?, ?, ?, ?, ?)
    `);

    insertUser.run('admin', hash, 'Admin User', 'admin@tstraffic.com.au', 'management');
    insertUser.run('ops_user', bcrypt.hashSync('password', 12), 'Sam Operations', 'sam@tstraffic.com.au', 'operations');
    insertUser.run('planning_user', bcrypt.hashSync('password', 12), 'Alex Planning', 'alex@tstraffic.com.au', 'planning');
    insertUser.run('marketing_user', bcrypt.hashSync('password', 12), 'Jordan Marketing', 'jordan@tstraffic.com.au', 'marketing');
    insertUser.run('accounts_user', bcrypt.hashSync('password', 12), 'Pat Accounts', 'pat@tstraffic.com.au', 'accounts');

    // Seed sample jobs
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
