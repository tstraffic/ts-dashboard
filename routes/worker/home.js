const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { getComplianceStatus } = require('../../middleware/compliance');

function localIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// GET /w/home — Worker home screen
router.get('/home', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const todayDate = new Date();
  const today = localIso(todayDate);

  // Get today's allocation(s) for this worker
  const todaysShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb, j.status as job_status,
      u.full_name as supervisor_name, u.email as supervisor_email
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC
  `).all(worker.id, today);

  todaysShifts.forEach(shift => {
    if (shift.supervisor_name) {
      const supUser = db.prepare('SELECT email FROM users WHERE full_name = ?').get(shift.supervisor_name);
      shift.supervisor_contact = supUser ? supUser.email : '';
    }
  });

  // Upcoming shifts (next 14 days, excluding today)
  const inTwoWeeks = new Date(todayDate); inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  const upcomingShifts = db.prepare(`
    SELECT ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type, ca.status,
           j.id as job_id, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date > ?
      AND ca.allocation_date <= ?
      AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
    LIMIT 5
  `).all(worker.id, today, localIso(inTwoWeeks));

  // Weekly strip: 7 days starting Monday of current week
  const weekStart = new Date(todayDate);
  const dow = (weekStart.getDay() + 6) % 7; // 0=Mon
  weekStart.setDate(weekStart.getDate() - dow);
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    weekDays.push({ iso: localIso(d), dayLetter: ['M','T','W','T','F','S','S'][i], dayNum: d.getDate(), isToday: localIso(d) === today, isPast: localIso(d) < today });
  }
  const weekStartIso = weekDays[0].iso;
  const weekEndIso = weekDays[6].iso;

  // Populate shift/leave status per day
  const weekAlloc = db.prepare(`
    SELECT allocation_date, shift_type, status FROM crew_allocations
    WHERE crew_member_id = ? AND allocation_date BETWEEN ? AND ? AND status != 'cancelled'
  `).all(worker.id, weekStartIso, weekEndIso);
  const weekLeave = db.prepare(`
    SELECT start_date, end_date, status FROM employee_leave
    WHERE crew_member_id = ? AND status != 'cancelled' AND NOT (end_date < ? OR start_date > ?)
  `).all(worker.id, weekStartIso, weekEndIso);

  weekDays.forEach(d => {
    const a = weekAlloc.find(x => x.allocation_date === d.iso);
    if (a) { d.kind = 'shift'; d.shiftType = a.shift_type; }
    const l = weekLeave.find(x => x.start_date <= d.iso && x.end_date >= d.iso);
    if (l && !a) { d.kind = 'leave'; d.leaveStatus = l.status; }
  });

  // Stats: hours this week (from timesheets approved/submitted), days worked last 7, upcoming count, leave pending
  const last7 = new Date(todayDate); last7.setDate(last7.getDate() - 6);
  const hoursRow = db.prepare(`
    SELECT COALESCE(SUM(total_hours), 0) as hrs FROM timesheets
    WHERE crew_member_id = ? AND work_date BETWEEN ? AND ?
  `).get(worker.id, weekStartIso, weekEndIso);
  const daysWorkedRow = db.prepare(`
    SELECT COUNT(DISTINCT DATE(event_time)) as c FROM clock_events
    WHERE crew_member_id = ? AND event_type = 'clock_in' AND DATE(event_time) BETWEEN ? AND ?
  `).get(worker.id, localIso(last7), today);
  const upcomingCount = db.prepare(`
    SELECT COUNT(*) as c FROM crew_allocations
    WHERE crew_member_id = ? AND allocation_date > ? AND allocation_date <= ? AND status != 'cancelled'
  `).get(worker.id, today, localIso(inTwoWeeks)).c;
  const pendingLeaveCount = db.prepare(`
    SELECT COUNT(*) as c FROM employee_leave
    WHERE crew_member_id = ? AND status = 'pending'
  `).get(worker.id).c;

  const stats = {
    hoursThisWeek: Number((hoursRow.hrs || 0).toFixed(1)),
    daysWorked: daysWorkedRow.c || 0,
    upcomingShifts: upcomingCount,
    pendingLeave: pendingLeaveCount,
  };

  // Latest clock event to determine "on shift" status
  const lastClock = db.prepare(`
    SELECT event_type, event_time FROM clock_events
    WHERE crew_member_id = ? ORDER BY event_time DESC LIMIT 1
  `).get(worker.id);
  const onShift = lastClock && lastClock.event_type === 'clock_in';

  // Recent activity: last 5 clock events + recent timesheet submissions
  const recentClocks = db.prepare(`
    SELECT 'clock' as kind, event_type as subtype, event_time as at, NULL as job_number
    FROM clock_events WHERE crew_member_id = ?
    ORDER BY event_time DESC LIMIT 5
  `).all(worker.id);

  // Get the crew member record for compliance check
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);
  const compliance = member ? getComplianceStatus(member, today) : null;

  // Time-based greeting
  const hour = todayDate.getHours();
  let greeting;
  if (hour < 12) greeting = 'Good morning';
  else if (hour < 17) greeting = 'Good afternoon';
  else greeting = 'Good evening';

  const firstName = worker.full_name.split(' ')[0];

  res.render('worker/home', {
    title: 'Home',
    currentPage: 'home',
    greeting,
    firstName,
    todaysShifts,
    upcomingShifts,
    weekDays,
    stats,
    onShift,
    recentClocks,
    compliance,
    member,
    today,
  });
});

module.exports = router;
