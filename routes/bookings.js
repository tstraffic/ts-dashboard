const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// ---- Sample booking data (will be replaced with DB queries later) ----
function getSampleBookings() {
  const db = getDb();

  // Pull real crew members for personnel
  let crewMembers = [];
  try {
    crewMembers = db.prepare(`SELECT id, first_name, last_name, role, ticket_number FROM crew_members WHERE active = 1 ORDER BY first_name LIMIT 30`).all();
  } catch (e) { /* table may not exist */ }

  // Pull real clients
  let clients = [];
  try {
    clients = db.prepare(`SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name LIMIT 20`).all();
  } catch (e) { /* table may not exist */ }

  // Pull real jobs/projects
  let jobs = [];
  try {
    jobs = db.prepare(`SELECT id, job_number, title, location, status FROM jobs ORDER BY id DESC LIMIT 20`).all();
  } catch (e) { /* table may not exist */ }

  const statuses = ['completed', 'green_to_go', 'confirmed', 'unconfirmed', 'in_progress', 'cancelled'];
  const depots = ['Villawood', 'Penrith', 'Campbelltown', 'Parramatta'];
  const addresses = [
    'Hill Rd, Sydney Olympic Park NSW, Australia',
    'Hyde Park, Elizabeth Street, Sydney NSW, Australia',
    'George St & Park St, Sydney NSW 2000',
    'Parramatta Rd, Granville NSW 2142',
    'Victoria Rd, Rydalmere NSW 2116',
    'Great Western Hwy, Penrith NSW 2750',
    'Canterbury Rd, Bankstown NSW 2200',
    'Hume Hwy, Liverpool NSW 2170',
    'Pacific Hwy, Chatswood NSW 2067',
    'Princes Hwy, Rockdale NSW 2216',
    'King Georges Rd, Wiley Park NSW 2195',
    'Cumberland Hwy, Merrylands NSW 2160',
    'Woodville Rd, Villawood NSW 2163',
    'Stacey St, Bankstown NSW 2200',
    'The Horsley Dr, Fairfield NSW 2165',
  ];
  const projectNames = [
    'Hill Road Widening, Olympic Park (A224) - Pedestrian Count',
    'Elizabeth St Water Main Replacement',
    'George St Light Rail Extension - Stage 2',
    'Parramatta Rd Resurfacing Works',
    'Victoria Rd Bridge Deck Repairs',
    'Great Western Hwy Upgrade - Penrith',
    'Canterbury Rd Intersection Upgrade',
    'Hume Hwy Median Strip Works',
    'Pacific Hwy Bus Lane Extension',
    'Princes Hwy Drainage Works',
    'King Georges Rd Safety Barrier Install',
    'Cumberland Hwy Road Widening',
    'Woodville Rd Service Relocation',
    'Stacey St Roundabout Construction',
    'Horsley Dr Traffic Signal Upgrade',
    'M4 On-Ramp Works - Merrylands',
    'WestConnex Surface Works - Haberfield',
    'Sydney Metro Station Box - Burwood',
  ];
  const clientNames = clients.length > 0
    ? clients.map(c => c.company_name)
    : ['Abergeldie Complex Infrastructure', 'Quality Management & Construction', 'Daracon Group', 'Fulton Hogan', 'Downer EDI', 'Lendlease', 'CPB Contractors', 'John Holland', 'Ventia', 'BMD Constructions', 'Seymour Whyte', 'Georgiou Group', 'Acciona', 'Laing O\'Rourke', 'Samsung C&T'];
  const supervisors = crewMembers.length > 0
    ? crewMembers.slice(0, 10).map(c => `${c.first_name} ${c.last_name}`)
    : ['Harry Iqbal', 'Andres A', 'Michael Chen', 'Sarah Williams', 'James Rodriguez', 'David Kim', 'Ahmed Hassan', 'Tom Wilson', 'Lisa Park', 'Mark Thompson'];
  const personnelNames = crewMembers.length > 0
    ? crewMembers.map(c => `${c.first_name} ${c.last_name}`)
    : ['Rania Bakri', 'Ryan Hand', 'Gabriela Santana', 'Helen Vesga', 'Mar Subirats', 'Jake Morrison', 'Sophie Chen', 'Omar Fahmy', 'Liam O\'Brien', 'Priya Patel', 'Carlos Mendez', 'Emma Stone', 'Wei Zhang', 'Fatima Al-Said', 'Daniel Cooper', 'Aisha Khan', 'Tom Brady', 'Yuki Tanaka', 'Raj Sharma', 'Chloe Davis'];

  const bookings = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 18; i++) {
    const status = statuses[i % statuses.length];
    const dayOffset = Math.floor(i / 4) - 1; // some yesterday, today, tomorrow
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() + dayOffset);
    const startHour = 5 + Math.floor(Math.random() * 4); // 5am - 8am
    const startMin = [0, 15, 30, 45][Math.floor(Math.random() * 4)];
    startDate.setHours(startHour, startMin, 0, 0);

    const durationHours = 4 + Math.floor(Math.random() * 8); // 4-11 hours
    const endDate = new Date(startDate);
    endDate.setHours(endDate.getHours() + durationHours);

    const numPersonnel = 2 + Math.floor(Math.random() * 5);
    const personnel = [];
    const usedNames = new Set();
    for (let p = 0; p < numPersonnel; p++) {
      let name;
      do {
        name = personnelNames[Math.floor(Math.random() * personnelNames.length)];
      } while (usedNames.has(name));
      usedNames.add(name);
      personnel.push({
        name,
        role: p === 0 ? 'Team Leader' : 'TC',
        confirmed: Math.random() > 0.2,
        qualified: Math.random() > 0.15,
        qualWarning: Math.random() > 0.8 ? (p === 0 ? 'Not qualified to be team leader' : 'Not qualified as a TC') : null,
      });
    }

    const hasVehicle = Math.random() > 0.3;
    const vehicles = hasVehicle ? [{
      id: `UTE-${String(1000 + i).slice(1)}`,
      plate: `${['ABC', 'DEF', 'GHI', 'JKL', 'MNO'][Math.floor(Math.random() * 5)]}${Math.floor(Math.random() * 900 + 100)}`,
      label: `TSTC ${String(i + 1).padStart(3, '0')}`,
    }] : [];

    const orderNum = ['A224', 'SP2', 'B105', 'C340', 'D782', 'E109', 'F456', 'G201'][i % 8];
    const clientName = clientNames[i % clientNames.length];

    bookings.push({
      id: 4100 + i * 3,
      status,
      startDateTime: startDate.toISOString(),
      endDateTime: endDate.toISOString(),
      depot: depots[i % depots.length],
      project: {
        name: projectNames[i % projectNames.length],
        client: clientName,
        parentOrg: clientName,
        address: addresses[i % addresses.length],
        orderNumber: orderNum,
        billingCode: orderNum,
      },
      supervisor: supervisors[i % supervisors.length],
      vehicles,
      personnel,
      scheduleWarning: Math.random() > 0.75 ? `Tight schedule (${Math.floor(Math.random() * 3) + 1}\u00BEhr)` : null,
      docs: Math.floor(Math.random() * 3),
      notes: Math.floor(Math.random() * 4),
      dockets: Math.floor(Math.random() * 2),
      tasks: Math.floor(Math.random() * 3),
      forms: Math.floor(Math.random() * 2),
      tags: [],
      billable: Math.random() > 0.1,
      invoiced: status === 'completed' ? Math.random() > 0.4 : false,
      title: projectNames[i % projectNames.length],
      depotMeetingTime: `0${startHour - 1}:${startMin === 0 ? '00' : startMin}`,
      straightToSiteTime: `0${startHour}:${startMin === 0 ? '00' : startMin}`,
      isCallout: false,
      isEmergency: false,
      bookingDescription: i % 3 === 0 ? 'Parking can be found on Fantail St and is a walkable distance to the site compound.\nToolbox every morning 0700 sharp at the compound/site office.\nFull PPE is mandatory.' : '',
    });
  }

  return bookings;
}

// GET /bookings — Board view (default)
router.get('/', (req, res) => {
  const view = req.query.view || 'board';
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  const depot = req.query.depot || '';
  const status = req.query.status || '';
  const search = req.query.search || '';

  let bookings = getSampleBookings();

  // Filter by depot
  if (depot) {
    bookings = bookings.filter(b => b.depot === depot);
  }

  // Filter by status
  if (status) {
    bookings = bookings.filter(b => b.status === status);
  }

  // Filter by search
  if (search) {
    const q = search.toLowerCase();
    bookings = bookings.filter(b =>
      b.project.name.toLowerCase().includes(q) ||
      b.project.client.toLowerCase().includes(q) ||
      b.project.address.toLowerCase().includes(q) ||
      b.supervisor.toLowerCase().includes(q) ||
      String(b.id).includes(q) ||
      b.personnel.some(p => p.name.toLowerCase().includes(q))
    );
  }

  // Stats
  const stats = {
    total: bookings.length,
    completed: bookings.filter(b => b.status === 'completed').length,
    greenToGo: bookings.filter(b => b.status === 'green_to_go').length,
    confirmed: bookings.filter(b => b.status === 'confirmed').length,
    unconfirmed: bookings.filter(b => b.status === 'unconfirmed').length,
    inProgress: bookings.filter(b => b.status === 'in_progress').length,
    cancelled: bookings.filter(b => b.status === 'cancelled').length,
  };

  const depots = ['Villawood', 'Penrith', 'Campbelltown', 'Parramatta'];

  res.render('bookings/index', {
    title: 'Bookings Board',
    bookings,
    stats,
    depots,
    currentView: view,
    currentDate: dateStr,
    currentDepot: depot,
    currentStatus: status,
    currentSearch: search,
    user: req.session.user,
  });
});

// GET /bookings/:id — Booking detail (JSON for modal)
router.get('/:id', (req, res) => {
  const bookings = getSampleBookings();
  const booking = bookings.find(b => b.id === parseInt(req.params.id));

  if (!booking) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    req.flash('error', 'Booking not found');
    return res.redirect('/bookings');
  }

  // If AJAX request, return JSON
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json(booking);
  }

  // Otherwise render detail page
  res.render('bookings/show', {
    title: `Booking #${booking.id}`,
    booking,
    user: req.session.user,
  });
});

module.exports = router;
