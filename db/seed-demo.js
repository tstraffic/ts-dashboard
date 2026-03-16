/**
 * Demo data seed script for T&S Operations Dashboard
 * Run: node db/seed-demo.js
 *
 * Seeds realistic Australian traffic management data for demos/screenshots.
 * Safe to run multiple times — checks for existing data before inserting.
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'tstraffic.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const today = new Date().toISOString().split('T')[0];
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString().split('T')[0];

// Check if demo data already seeded
const existingClients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
if (existingClients >= 8) {
  console.log('Demo data appears to already be seeded. Skipping.');
  process.exit(0);
}

console.log('Seeding demo data...');

// ============================================
// CLIENTS
// ============================================
const insertClient = db.prepare(`INSERT OR IGNORE INTO clients (company_name, abn, primary_contact_name, primary_contact_phone, primary_contact_email, address, payment_terms, notes, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);

const clients = [
  ['Transport for NSW', '18 790 919 264', 'Mark Sullivan', '02 8588 5500', 'mark.sullivan@transport.nsw.gov.au', 'Level 7, 18 Lee St, Chippendale NSW 2008', 'Net 30', 'State government transport authority'],
  ['Georgiou Group', '11 060 526 148', 'James Papadopoulos', '02 9955 4100', 'j.papadopoulos@georgiou.com.au', '45 William St, Melbourne VIC 3000', 'Net 30', 'Major civil infrastructure contractor'],
  ['Fulton Hogan', '54 004 512 713', 'Rachel Chen', '02 8668 2000', 'rachel.chen@fultonhogan.com.au', '20 Rodborough Rd, Frenchs Forest NSW 2086', 'Net 14', 'Road construction and maintenance'],
  ['Acciona Infrastructure', '87 156 189 972', 'David Torres', '02 9274 5200', 'd.torres@acciona.com.au', '680 George St, Sydney NSW 2000', 'Net 45', 'International infrastructure group'],
  ['City of Sydney', '22 636 550 790', 'Sarah Mitchell', '02 9265 9333', 's.mitchell@cityofsydney.nsw.gov.au', 'Town Hall House, 456 Kent St, Sydney NSW 2000', 'Net 30', 'Local council'],
  ['CPB Contractors', '99 010 363 783', 'Andrew Williams', '02 9925 6666', 'a.williams@cpbcon.com.au', 'Level 18, 177 Pacific Hwy, North Sydney NSW 2060', 'Net 30', 'Major project delivery partner'],
  ['John Holland', '11 004 282 268', 'Lisa Nguyen', '02 9552 4100', 'l.nguyen@johnholland.com.au', '111 Bourke St, Melbourne VIC 3000', 'Net 30', 'Heavy civil and tunnelling'],
  ['Penrith City Council', '53 434 286 867', 'Tom Bradley', '02 4732 7777', 't.bradley@penrith.city', '601 High St, Penrith NSW 2750', 'Net 30', 'Western Sydney council'],
];

clients.forEach(c => insertClient.run(...c));
console.log(`  Clients: ${clients.length} seeded`);

// Get client IDs
const clientMap = {};
db.prepare('SELECT id, company_name FROM clients').all().forEach(c => { clientMap[c.company_name] = c.id; });

// Get user IDs
const userMap = {};
db.prepare('SELECT id, username FROM users').all().forEach(u => { userMap[u.username] = u.id; });
const adminId = userMap['admin'] || 1;
const opsId = userMap['ops_user'] || adminId;
const planningId = userMap['planning_user'] || adminId;
const financeId = userMap['finance_user'] || adminId;

// ============================================
// JOBS (additional — beyond the existing 5)
// ============================================
const insertJob = db.prepare(`INSERT OR IGNORE INTO jobs (job_number, job_name, client, client_id, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, accounts_owner_id, health, accounts_status, contract_value, estimated_hours, crew_size, state, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const jobs = [
  ['J-02456', 'Pacific Highway Upgrade - Wahroonga', 'Transport for NSW', clientMap['Transport for NSW'], '221 Pacific Hwy', 'Wahroonga', 'active', 'delivery', 35, daysAgo(45), daysFromNow(120), adminId, opsId, planningId, financeId, 'green', 'on_track', 185000, 2400, 6, 'NSW', 'Lane closures and traffic staging for road widening'],
  ['J-02457', 'M4 Smart Motorway - Eastern Creek', 'CPB Contractors', clientMap['CPB Contractors'], 'M4 Motorway', 'Eastern Creek', 'active', 'delivery', 60, daysAgo(90), daysFromNow(60), adminId, opsId, planningId, financeId, 'amber', 'on_track', 320000, 4200, 12, 'NSW', 'TMA and lane closures for smart motorway installation'],
  ['J-02458', 'George St Pedestrian Zone - Stage 3', 'City of Sydney', clientMap['City of Sydney'], 'George St between King & Market', 'Sydney CBD', 'active', 'delivery', 80, daysAgo(120), daysFromNow(30), opsId, opsId, planningId, financeId, 'green', 'on_track', 95000, 1100, 4, 'NSW', 'Traffic control for light rail and pedestrian works'],
  ['J-02459', 'Parramatta Light Rail - Enabling Works', 'Acciona Infrastructure', clientMap['Acciona Infrastructure'], 'Church St', 'Parramatta', 'active', 'delivery', 20, daysAgo(30), daysFromNow(180), adminId, opsId, planningId, financeId, 'red', 'on_track', 450000, 6000, 15, 'NSW', 'Complex intersection staging. Behind schedule due to utility conflicts.'],
  ['J-02460', 'Northern Beaches Road Resurfacing', 'Fulton Hogan', clientMap['Fulton Hogan'], 'Pittwater Rd', 'Dee Why', 'active', 'delivery', 45, daysAgo(60), daysFromNow(90), adminId, opsId, planningId, financeId, 'green', 'on_track', 78000, 900, 4, 'NSW', 'Night works resurfacing program'],
  ['J-02461', 'WestConnex Integration Works', 'John Holland', clientMap['John Holland'], 'Wattle St Interchange', 'Haberfield', 'won', 'prestart', 0, daysFromNow(14), daysFromNow(200), adminId, opsId, planningId, financeId, 'green', 'na', 520000, 7500, 18, 'NSW', 'Awaiting mobilisation. ROL and TMP required.'],
  ['J-02462', 'Penrith CBD Streetscape Upgrade', 'Penrith City Council', clientMap['Penrith City Council'], 'High St & Henry St', 'Penrith', 'active', 'delivery', 55, daysAgo(75), daysFromNow(45), opsId, opsId, planningId, financeId, 'amber', 'on_track', 125000, 1600, 5, 'NSW', 'Footpath widening and intersection upgrades. Some approval delays.'],
  ['J-02463', 'Sydney Metro West - Surface Works', 'Georgiou Group', clientMap['Georgiou Group'], 'Burwood Rd', 'Burwood', 'tender', 'tender', 0, daysFromNow(60), daysFromNow(365), null, null, planningId, null, 'green', 'na', 680000, 9000, 20, 'NSW', 'Major tender. Pricing due in 2 weeks.'],
];

jobs.forEach(j => insertJob.run(...j));
console.log(`  Jobs: ${jobs.length} additional seeded`);

// Get all job IDs
const jobMap = {};
db.prepare('SELECT id, job_number FROM jobs').all().forEach(j => { jobMap[j.job_number] = j.id; });

// ============================================
// CREW MEMBERS (25 realistic TC workers)
// ============================================
const existingCrew = db.prepare('SELECT COUNT(*) as c FROM crew_members').get().c;
if (existingCrew < 10) {
  const insertCrew = db.prepare(`INSERT OR IGNORE INTO crew_members (full_name, employee_id, role, phone, email, active, hourly_rate, tcp_level, white_card, white_card_expiry, tc_ticket, tc_ticket_expiry, ti_ticket, ti_ticket_expiry, first_aid, first_aid_expiry, medical_expiry, company, employment_type, induction_status, status) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const crew = [
    ['John Smith', 'EMP-001', 'supervisor', '0412 345 678', 'john.s@tstc.com.au', 55, 'TCP-3', 'WC-30291', daysFromNow(200), 'TC-11234', daysFromNow(180), 'TI-5567', daysFromNow(300), 'FA-8801', daysFromNow(150), daysFromNow(365), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Sarah Wilson', 'EMP-002', 'leading_hand', '0423 456 789', 'sarah.w@tstc.com.au', 48, 'TCP-2', 'WC-30292', daysFromNow(90), 'TC-11235', daysFromNow(45), '', null, 'FA-8802', daysFromNow(220), daysFromNow(280), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Michael Tran', 'EMP-003', 'traffic_controller', '0434 567 890', 'michael.t@tstc.com.au', 42, 'TCP-2', 'WC-30293', daysFromNow(150), 'TC-11236', daysFromNow(120), '', null, 'FA-8803', daysFromNow(100), daysFromNow(200), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Emma Rodriguez', 'EMP-004', 'traffic_controller', '0445 678 901', 'emma.r@tstc.com.au', 42, 'TCP-1', 'WC-30294', daysFromNow(300), 'TC-11237', daysFromNow(250), '', null, 'FA-8804', daysFromNow(180), daysFromNow(400), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['David Nguyen', 'EMP-005', 'supervisor', '0456 789 012', 'david.n@tstc.com.au', 58, 'TCP-3', 'WC-30295', daysFromNow(60), 'TC-11238', daysFromNow(30), 'TI-5568', daysFromNow(280), 'FA-8805', daysFromNow(90), daysFromNow(120), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Jessica Patel', 'EMP-006', 'traffic_controller', '0467 890 123', 'jessica.p@tstc.com.au', 42, 'TCP-1', 'WC-30296', daysFromNow(400), 'TC-11239', daysFromNow(350), '', null, 'FA-8806', daysFromNow(300), daysFromNow(500), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Ryan O\'Brien', 'EMP-007', 'leading_hand', '0478 901 234', 'ryan.o@tstc.com.au', 48, 'TCP-2', 'WC-30297', daysFromNow(180), 'TC-11240', daysFromNow(160), 'TI-5569', daysFromNow(200), 'FA-8807', daysFromNow(250), daysFromNow(300), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Amanda Lee', 'EMP-008', 'traffic_controller', '0489 012 345', 'amanda.l@tstc.com.au', 42, 'TCP-1', 'WC-30298', daysAgo(10), 'TC-11241', daysFromNow(100), '', null, 'FA-8808', daysFromNow(50), daysFromNow(150), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Chris Murphy', 'EMP-009', 'pilot_vehicle', '0490 123 456', 'chris.m@tstc.com.au', 45, 'TCP-1', 'WC-30299', daysFromNow(220), 'TC-11242', daysFromNow(190), '', null, 'FA-8809', daysFromNow(170), daysFromNow(350), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Priya Sharma', 'EMP-010', 'traffic_controller', '0401 234 567', 'priya.s@tstc.com.au', 42, 'TCP-2', 'WC-30300', daysFromNow(280), 'TC-11243', daysFromNow(240), '', null, 'FA-8810', daysFromNow(200), daysFromNow(380), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['James Cook', 'EMP-011', 'traffic_controller', '0413 345 678', '', 42, 'TCP-1', 'WC-30301', daysFromNow(100), 'TC-11244', daysFromNow(15), '', null, '', null, daysFromNow(90), '', 'casual', 'completed', 'active'],
    ['Mei Lin Zhang', 'EMP-012', 'traffic_controller', '0424 456 789', '', 42, 'TCP-1', 'WC-30302', daysFromNow(350), 'TC-11245', daysFromNow(300), '', null, 'FA-8812', daysFromNow(250), daysFromNow(400), '', 'casual', 'completed', 'active'],
    ['Tom Fletcher', 'EMP-013', 'labourer', '0435 567 890', '', 38, '', 'WC-30303', daysFromNow(180), '', null, '', null, '', null, null, '', 'casual', 'completed', 'active'],
    ['Kelly Johnson', 'EMP-014', 'traffic_controller', '0446 678 901', 'kelly.j@tstc.com.au', 42, 'TCP-2', 'WC-30304', daysFromNow(200), 'TC-11247', daysFromNow(170), '', null, 'FA-8814', daysFromNow(120), daysFromNow(300), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Sam Ibrahim', 'EMP-015', 'supervisor', '0457 789 012', 'sam.i@tstc.com.au', 55, 'TCP-3', 'WC-30305', daysFromNow(250), 'TC-11248', daysFromNow(220), 'TI-5570', daysFromNow(180), 'FA-8815', daysFromNow(160), daysFromNow(280), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Lily Wang', 'EMP-016', 'traffic_controller', '0468 890 123', '', 42, 'TCP-1', 'WC-30306', daysFromNow(320), 'TC-11249', daysFromNow(280), '', null, '', null, daysFromNow(350), '', 'casual', 'pending', 'active'],
    ['Daniel Costa', 'EMP-017', 'leading_hand', '0479 901 234', 'daniel.c@tstc.com.au', 48, 'TCP-2', 'WC-30307', daysFromNow(140), 'TC-11250', daysFromNow(110), '', null, 'FA-8817', daysFromNow(80), daysFromNow(220), 'T&S Traffic Control', 'employee', 'completed', 'active'],
    ['Rachel Adams', 'EMP-018', 'traffic_controller', '0480 012 345', '', 42, 'TCP-1', 'WC-30308', daysFromNow(260), 'TC-11251', daysFromNow(230), '', null, 'FA-8818', daysFromNow(200), daysFromNow(360), '', 'casual', 'completed', 'active'],
    ['Ben Taylor', 'EMP-019', 'spotter', '0491 123 456', '', 40, '', 'WC-30309', daysFromNow(100), '', null, '', null, '', null, null, '', 'casual', 'completed', 'active'],
    ['Aisha Mohammed', 'EMP-020', 'traffic_controller', '0402 234 567', 'aisha.m@tstc.com.au', 42, 'TCP-2', 'WC-30310', daysFromNow(190), 'TC-11253', daysFromNow(160), '', null, 'FA-8820', daysFromNow(130), daysFromNow(270), 'T&S Traffic Control', 'employee', 'completed', 'active'],
  ];

  crew.forEach(c => insertCrew.run(...c));
  console.log(`  Crew: ${crew.length} seeded`);
}

// ============================================
// EQUIPMENT (15 assets)
// ============================================
const existingEquip = db.prepare('SELECT COUNT(*) as c FROM equipment').get().c;
if (existingEquip < 5) {
  const insertEquip = db.prepare(`INSERT OR IGNORE INTO equipment (asset_number, name, category, description, serial_number, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);

  const equipment = [
    ['TMA-001', 'Scorpion TMA Truck #1', 'vehicle', '15T TMA with energy-absorbing attenuator', 'SCO-2022-4451', '2022-06-15', 185000, 'good', 'Wetherill Park Depot', daysFromNow(30), 90],
    ['TMA-002', 'Scorpion TMA Truck #2', 'vehicle', '15T TMA with energy-absorbing attenuator', 'SCO-2022-4452', '2022-06-15', 185000, 'good', 'Wetherill Park Depot', daysFromNow(45), 90],
    ['TMA-003', 'Scorpion TMA Truck #3', 'vehicle', '15T TMA - rear impact damage repaired', 'SCO-2023-5501', '2023-03-10', 195000, 'fair', 'On Site - M4 Eastern Creek', daysFromNow(12), 90],
    ['AB-001', 'LED Arrow Board - Trailer', 'arrow_board', 'C-size arrow board on single-axle trailer', 'ARB-2021-1101', '2021-11-20', 12500, 'good', 'Wetherill Park Depot', daysFromNow(60), 180],
    ['AB-002', 'LED Arrow Board - Trailer', 'arrow_board', 'C-size arrow board on single-axle trailer', 'ARB-2021-1102', '2021-11-20', 12500, 'good', 'On Site - Pacific Hwy', daysFromNow(75), 180],
    ['AB-003', 'LED Arrow Board - Vehicle Mount', 'arrow_board', 'B-size vehicle-mount arrow board', 'ARB-2023-2201', '2023-04-08', 8500, 'new', 'Wetherill Park Depot', daysFromNow(120), 180],
    ['VMS-001', 'Variable Message Sign - Trailer', 'vms', '3-line LED VMS on trailer, solar powered', 'VMS-2022-0801', '2022-08-15', 35000, 'good', 'On Site - Parramatta', daysFromNow(20), 90],
    ['VMS-002', 'Variable Message Sign - Trailer', 'vms', '3-line LED VMS on trailer, solar powered', 'VMS-2023-0301', '2023-03-01', 38000, 'good', 'Wetherill Park Depot', daysFromNow(55), 90],
    ['PV-001', 'Pilot Vehicle - Toyota Hilux', 'vehicle', 'Pilot vehicle with roof-mount signage', 'TOY-2023-PV01', '2023-01-15', 65000, 'good', 'Wetherill Park Depot', daysFromNow(40), 90],
    ['PV-002', 'Pilot Vehicle - Ford Ranger', 'vehicle', 'Pilot vehicle with roof-mount signage', 'FRD-2024-PV02', '2024-02-10', 72000, 'new', 'On Site - Dee Why', daysFromNow(80), 90],
    ['BAR-SET-01', 'Water-Filled Barrier Set (20)', 'barrier', '20x 1.5m water-filled plastic barriers', 'WFB-2022-SET01', '2022-05-01', 8000, 'good', 'On Site - George St', daysFromNow(90), 365],
    ['BAR-SET-02', 'Concrete Barrier Set (10)', 'barrier', '10x 3.6m F-Type concrete barriers', 'FCB-2021-SET02', '2021-09-01', 15000, 'fair', 'On Site - M4 Eastern Creek', daysAgo(5), 365],
    ['LT-001', 'Portable Light Tower - LED', 'lighting', 'Solar/diesel LED light tower', 'PLT-2023-0501', '2023-05-15', 18000, 'good', 'Wetherill Park Depot', daysFromNow(65), 180],
    ['CONE-SET-01', 'Traffic Cone Set (100)', 'cone', '100x 700mm reflective cones', 'CON-2023-100A', '2023-01-01', 2500, 'good', 'Wetherill Park Depot', null, 365],
    ['DEL-SET-01', 'Delineator Post Set (50)', 'delineator', '50x T-top delineator posts with bases', 'DEL-2023-50A', '2023-06-01', 3000, 'good', 'On Site - Penrith', null, 365],
  ];

  equipment.forEach(e => insertEquip.run(...e));
  console.log(`  Equipment: ${equipment.length} seeded`);
}

// ============================================
// ADDITIONAL TASKS
// ============================================
const existingTasks = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
if (existingTasks < 10) {
  const insertTask = db.prepare(`INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const tasks = [
    [jobMap['J-02457'], 'ops', 'Review night works schedule for Week 12', 'Confirm TMA positioning and crew roster for upcoming night shift block', opsId, daysFromNow(3), 'in_progress', 'high', 'one_off'],
    [jobMap['J-02459'], 'planning', 'Submit revised TMP for Church St intersection', 'Council requested changes to staging sequence. Need TfNSW endorsement.', planningId, daysAgo(2), 'not_started', 'high', 'one_off'],
    [jobMap['J-02456'], 'ops', 'Confirm crew for Pacific Hwy weekend works', 'Need 6 TCs + 1 supervisor confirmed for Saturday night shift', opsId, daysFromNow(5), 'not_started', 'medium', 'weekly'],
    [jobMap['J-02460'], 'finance', 'Submit progress claim #3 - Fulton Hogan', 'Monthly progress claim for Dee Why resurfacing works', financeId, daysFromNow(7), 'not_started', 'medium', 'one_off'],
    [jobMap['J-02462'], 'planning', 'Lodge council permit extension - Penrith', 'Current permit expires in 2 weeks, need 30-day extension', planningId, daysFromNow(10), 'not_started', 'medium', 'one_off'],
    [jobMap['J-02461'], 'ops', 'Complete site induction for WestConnex', 'All crew must complete John Holland site induction before mobilisation', opsId, daysFromNow(12), 'not_started', 'high', 'one_off'],
    [jobMap['J-02458'], 'admin', 'Archive George St project docs', 'Project nearing completion — prepare closeout docs', adminId, daysFromNow(20), 'not_started', 'low', 'one_off'],
  ];

  tasks.forEach(t => insertTask.run(...t));
  console.log(`  Tasks: ${tasks.length} additional seeded`);
}

// ============================================
// INCIDENTS
// ============================================
const existingIncidents = db.prepare('SELECT COUNT(*) as c FROM incidents').get().c;
if (existingIncidents < 2) {
  const insertIncident = db.prepare(`INSERT INTO incidents (job_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, immediate_actions, investigation_status, notifiable_incident) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const incidents = [
    [jobMap['J-02457'], 'INC-00001', 'near_miss', 'medium', 'Vehicle entered workzone on M4', 'Motorist drove through coned-off area at approx 80km/h. No contact with workers or equipment. TMA was in place.', 'M4 Motorway, Eastbound lane 3', daysAgo(5), '22:30', adminId, 'Stopped works immediately. Reviewed TGS setup. Added extra delineation. Reported to TfNSW TMC.', 'investigating', 0],
    [jobMap['J-02459'], 'INC-00002', 'property_damage', 'low', 'Barrier knocked by delivery truck', 'Water-filled barrier displaced by a delivery truck reversing at Church St. No injuries. Barrier undamaged.', 'Church St & Macquarie St intersection', daysAgo(12), '14:15', opsId, 'Barrier repositioned. Driver spoken to by supervisor.', 'resolved', 0],
    [jobMap['J-02456'], 'INC-00003', 'hazard', 'high', 'Unstable trench edge near pedestrian path', 'Trench edge within 500mm of active pedestrian walkway showing signs of subsidence. Risk of collapse.', 'Pacific Hwy, southbound footpath near #221', daysAgo(1), '09:45', opsId, 'Area barricaded. Pedestrian detour implemented. Principal contractor notified for urgent shoring.', 'reported', 0],
  ];

  incidents.forEach(i => insertIncident.run(...i));
  console.log(`  Incidents: ${incidents.length} seeded`);
}

// ============================================
// DEFECTS
// ============================================
const existingDefects = db.prepare('SELECT COUNT(*) as c FROM defects').get().c;
if (existingDefects < 2) {
  const insertDefect = db.prepare(`INSERT INTO defects (job_id, defect_number, title, description, location, severity, status, reported_by_id, assigned_to_id, reported_date, target_close_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const defects = [
    [jobMap['J-02457'], 'DEF-00001', 'Damaged arrow board LED panel', 'Top-right LED module on AB-002 has dead pixels. Still functional but degraded visibility.', 'M4 Eastbound workzone', 'moderate', 'open', adminId, opsId, daysAgo(8), daysFromNow(7)],
    [jobMap['J-02459'], 'DEF-00002', 'Missing sign face - speed advisory', 'Speed advisory sign (40km/h) missing from post at eastern approach. Unknown if stolen or removed.', 'Church St approach from east', 'major', 'investigating', opsId, opsId, daysAgo(3), daysFromNow(2)],
    [jobMap['J-02462'], 'DEF-00003', 'Loose bollard base plate', 'Bollard at pedestrian crossing has loose base plate. Wobbles when contacted.', 'High St / Henry St intersection NW corner', 'minor', 'open', opsId, null, daysAgo(1), daysFromNow(14)],
    [jobMap['J-02456'], 'DEF-00004', 'Cracked water-filled barrier', 'One barrier in set has hairline crack at base. Slow leak when filled.', 'Pacific Hwy workzone staging area', 'moderate', 'rectification', adminId, opsId, daysAgo(15), daysAgo(5)],
    [jobMap['J-02460'], 'DEF-00005', 'Faded line marking at detour entry', 'Temporary line marking at detour entry point has faded to near-invisible. Repainting required.', 'Pittwater Rd detour entry southbound', 'major', 'open', opsId, null, daysAgo(2), daysFromNow(3)],
  ];

  defects.forEach(d => insertDefect.run(...d));
  console.log(`  Defects: ${defects.length} seeded`);
}

// ============================================
// ADDITIONAL COMPLIANCE/APPROVALS
// ============================================
const existingCompliance = db.prepare('SELECT COUNT(*) as c FROM compliance').get().c;
if (existingCompliance < 8) {
  const insertCompliance = db.prepare(`INSERT INTO compliance (job_id, item_type, title, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const compliance = [
    [jobMap['J-02461'], 'rol', 'Road Occupancy Licence - Wattle St', planningId, daysFromNow(10), null, null, null, 'not_started', 'Required before mobilisation. TfNSW application pending.'],
    [jobMap['J-02461'], 'tmp_approval', 'Traffic Management Plan - WestConnex', planningId, daysFromNow(7), daysAgo(5), null, null, 'submitted', 'Submitted to John Holland for review. Awaiting response.'],
    [jobMap['J-02459'], 'council_permit', 'Road Closure Permit - Church St', planningId, daysAgo(3), daysAgo(15), null, null, 'submitted', 'Parramatta Council reviewing. Follow up needed.'],
    [jobMap['J-02456'], 'traffic_guidance', 'Traffic Guidance Scheme - Pacific Hwy Stage 2', planningId, daysFromNow(14), daysAgo(10), null, null, 'submitted', 'Updated staging for lane shift. Awaiting TfNSW approval.'],
    [jobMap['J-02460'], 'rol', 'Road Occupancy Licence - Pittwater Rd Night Works', planningId, daysAgo(1), daysAgo(20), daysAgo(18), daysFromNow(15), 'approved', 'Approved for 10pm-5am nightly. Renewal needed before expiry.'],
  ];

  compliance.forEach(c => insertCompliance.run(...c));
  console.log(`  Compliance: ${compliance.length} additional seeded`);
}

// ============================================
// TIMESHEETS (last 7 days)
// ============================================
const existingTimesheets = db.prepare('SELECT COUNT(*) as c FROM timesheets').get().c;
if (existingTimesheets < 5) {
  const crewIds = db.prepare('SELECT id FROM crew_members WHERE active = 1 LIMIT 10').all().map(c => c.id);
  const activeJobIds = db.prepare("SELECT id FROM jobs WHERE status = 'active' LIMIT 5").all().map(j => j.id);

  const insertTimesheet = db.prepare(`INSERT INTO timesheets (job_id, crew_member_id, work_date, start_time, end_time, break_minutes, total_hours, shift_type, role_on_site, approved, submitted_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (let d = 1; d <= 7; d++) {
    const workDate = daysAgo(d);
    const dayOfWeek = new Date(Date.now() - d * 86400000).getDay();
    if (dayOfWeek === 0) continue; // skip Sunday

    const numWorkers = dayOfWeek === 6 ? 4 : Math.min(8, crewIds.length); // fewer on Saturday
    for (let w = 0; w < numWorkers && w < crewIds.length; w++) {
      const jobId = activeJobIds[w % activeJobIds.length];
      const isNight = w % 3 === 0;
      const start = isNight ? '18:00' : '06:30';
      const end = isNight ? '04:00' : '16:30';
      const hours = isNight ? 9.5 : 9.5;
      const shift = isNight ? 'night' : 'day';
      const roles = ['Traffic Controller', 'Leading Hand', 'Supervisor', 'Pilot Vehicle', 'Traffic Controller'];
      insertTimesheet.run(jobId, crewIds[w], workDate, start, end, 30, hours, shift, roles[w % roles.length], d > 3 ? 1 : 0, adminId);
    }
  }
  console.log(`  Timesheets: ~50 entries seeded (7 days)`);
}

// ============================================
// CONTACTS
// ============================================
const existingContacts = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='contacts'").get().c;
if (existingContacts > 0) {
  const contactCount = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  if (contactCount < 3) {
    try {
      const insertContact = db.prepare(`INSERT INTO contacts (name, company, role, phone, email, job_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);

      const contacts = [
        ['Mark Sullivan', 'Transport for NSW', 'Project Director', '02 8588 5500', 'mark.sullivan@transport.nsw.gov.au', jobMap['J-02456'], 'Main TfNSW contact for Pacific Hwy works'],
        ['James Papadopoulos', 'Georgiou Group', 'Site Manager', '0421 555 123', 'j.papadopoulos@georgiou.com.au', jobMap['J-02463'], 'Tender contact for Sydney Metro West'],
        ['Rachel Chen', 'Fulton Hogan', 'Project Engineer', '0432 555 234', 'rachel.chen@fultonhogan.com.au', jobMap['J-02460'], 'PM for Dee Why resurfacing'],
        ['David Torres', 'Acciona Infrastructure', 'Construction Manager', '0443 555 345', 'd.torres@acciona.com.au', jobMap['J-02459'], 'Lead for Parramatta Light Rail enabling works'],
        ['Tom Bradley', 'Penrith City Council', 'Roads Coordinator', '02 4732 7777', 't.bradley@penrith.city', jobMap['J-02462'], 'Council contact for permit and road closure coordination'],
      ];

      contacts.forEach(c => insertContact.run(...c));
      console.log(`  Contacts: ${contacts.length} seeded`);
    } catch (e) {
      console.log(`  Contacts: skipped (table structure mismatch)`);
    }
  }
}

// ============================================
// JOB BUDGETS
// ============================================
try {
  const existingBudgets = db.prepare('SELECT COUNT(*) as c FROM job_budgets').get().c;
  if (existingBudgets < 3) {
    const insertBudget = db.prepare(`INSERT OR IGNORE INTO job_budgets (job_id, contract_value, labour_budget, materials_budget, subcontractor_budget, equipment_budget, other_budget, contingency_budget, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const budgets = [
      [jobMap['J-02456'], 185000, 95000, 15000, 35000, 25000, 5000, 10000, 'Pacific Hwy budget breakdown'],
      [jobMap['J-02457'], 320000, 160000, 25000, 60000, 50000, 10000, 15000, 'M4 Smart Motorway budget'],
      [jobMap['J-02459'], 450000, 230000, 30000, 90000, 65000, 15000, 20000, 'Parramatta Light Rail enabling'],
      [jobMap['J-02462'], 125000, 65000, 12000, 25000, 15000, 3000, 5000, 'Penrith CBD streetscape'],
    ];

    budgets.forEach(b => insertBudget.run(...b));
    console.log(`  Budgets: ${budgets.length} seeded`);
  }
} catch (e) {
  console.log(`  Budgets: skipped (table may not exist)`);
}

// ============================================
// COST ENTRIES
// ============================================
try {
  const existingCosts = db.prepare('SELECT COUNT(*) as c FROM cost_entries').get().c;
  if (existingCosts < 3) {
    const insertCost = db.prepare(`INSERT INTO cost_entries (job_id, category, description, amount, date, invoice_ref, supplier, entered_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const costs = [
      [jobMap['J-02456'], 'labour', 'Week 1-4 crew labour', 22500, daysAgo(30), 'INV-2456-001', 'Internal', financeId],
      [jobMap['J-02456'], 'equipment', 'TMA hire - 4 weeks', 12000, daysAgo(25), 'INV-2456-002', 'T&S Fleet', financeId],
      [jobMap['J-02457'], 'labour', 'Week 1-8 crew labour', 68000, daysAgo(20), 'INV-2457-001', 'Internal', financeId],
      [jobMap['J-02457'], 'equipment', 'TMA x2 + Arrow boards', 28000, daysAgo(18), 'INV-2457-002', 'T&S Fleet', financeId],
      [jobMap['J-02457'], 'materials', 'Cones and delineators', 3500, daysAgo(15), 'INV-2457-003', 'Traffix Devices', financeId],
      [jobMap['J-02459'], 'labour', 'Week 1-3 crew labour', 34000, daysAgo(14), 'INV-2459-001', 'Internal', financeId],
      [jobMap['J-02459'], 'subcontractor', 'Line marking sub', 8500, daysAgo(10), 'INV-2459-002', 'Roadline Markings', financeId],
    ];

    costs.forEach(c => insertCost.run(...c));
    console.log(`  Cost entries: ${costs.length} seeded`);
  }
} catch (e) {
  console.log(`  Costs: skipped (table may not exist)`);
}

console.log('\nDemo data seeding complete!');
db.close();
