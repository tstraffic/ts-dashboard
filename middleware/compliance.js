const { getDb } = require('../db/database');
const { getConfig } = require('./settings');

/**
 * Compute full compliance status for a single crew member.
 * @param {Object} member - row from crew_members table (all columns)
 * @param {string} [referenceDate] - ISO date string, defaults to today
 * @returns {Object} compliance status object
 */
function getComplianceStatus(member, referenceDate) {
  const today = referenceDate || new Date().toISOString().split('T')[0];
  const db = getDb();

  // Fatigue check: days worked in last 7 days (allocations + timesheets)
  const fatigue = db.prepare(`
    SELECT COUNT(DISTINCT d.work_day) as days_worked FROM (
      SELECT allocation_date as work_day FROM crew_allocations
      WHERE crew_member_id = ? AND status IN ('allocated','confirmed')
      AND allocation_date BETWEEN date(?, '-6 days') AND date(?)
      UNION
      SELECT work_date as work_day FROM timesheets
      WHERE crew_member_id = ?
      AND work_date BETWEEN date(?, '-6 days') AND date(?)
    ) d
  `).get(member.id, today, today, member.id, today, today);

  const daysWorked = fatigue ? fatigue.days_worked : 0;
  const fatigueMaxDays = getConfig('fatigue_max_days', 5);
  const fatigueBlocked = daysWorked >= fatigueMaxDays;

  // Expiry checks
  const expiryFields = [
    { field: 'tc_ticket_expiry', label: 'TC Ticket', required: !!member.tc_ticket },
    { field: 'ti_ticket_expiry', label: 'TI Ticket', required: !!member.ti_ticket },
    { field: 'white_card_expiry', label: 'White Card', required: !!member.white_card },
    { field: 'first_aid_expiry', label: 'First Aid', required: !!member.first_aid },
    { field: 'medical_expiry', label: 'Medical', required: !!member.medical_expiry },
  ];

  const warningDays = getConfig('ticket_expiry_warning_days', 30);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + warningDays);
  const soon30Str = soon.toISOString().split('T')[0];

  let allTicketsValid = true;
  let licenceValid = true;
  const expiredItems = [];
  const expiringItems = [];
  const missingItems = [];

  // Check licence separately
  if (member.licence_type && member.licence_expiry) {
    if (member.licence_expiry < today) {
      licenceValid = false;
      expiredItems.push({ label: 'Licence', date: member.licence_expiry });
    } else if (member.licence_expiry <= soon30Str) {
      expiringItems.push({ label: 'Licence', date: member.licence_expiry });
    }
  } else if (member.licence_type && !member.licence_expiry) {
    missingItems.push('Licence expiry date');
  }

  // Check ticket/cert expiries
  for (const check of expiryFields) {
    const val = member[check.field];
    if (check.required && !val) {
      missingItems.push(check.label + ' expiry date');
    }
    if (val && val < today) {
      expiredItems.push({ label: check.label, date: val });
      allTicketsValid = false;
    } else if (val && val <= soon30Str) {
      expiringItems.push({ label: check.label, date: val });
    }
  }

  // Missing docs: required identity fields that are empty
  if (!member.phone) missingItems.push('Phone');
  if (!member.email) missingItems.push('Email');
  if (!member.employee_id) missingItems.push('Employee ID');

  const inductionComplete = member.induction_status === 'completed';
  const supervisorApproved = !!member.supervisor_approved;
  const isActive = !!member.active;

  // Can be allocated = active + induction cleared + no expired tickets + no fatigue block
  const canAllocate = isActive && inductionComplete && allTicketsValid
    && licenceValid && !fatigueBlocked;

  return {
    isActive,
    canAllocate,
    inductionComplete,
    allTicketsValid,
    licenceValid,
    fatigueBlocked,
    daysWorked,
    supervisorApproved,
    missingDocs: missingItems.length > 0,
    missingItems,
    expiredItems,
    expiringItems,
  };
}

/**
 * Batch-compute fatigue for all active crew at once (performance optimisation).
 * Returns a Map of crewMemberId → daysWorked.
 */
function getBatchFatigue(referenceDate) {
  const today = referenceDate || new Date().toISOString().split('T')[0];
  const db = getDb();
  const rows = db.prepare(`
    SELECT crew_member_id, COUNT(DISTINCT work_day) as days_worked FROM (
      SELECT crew_member_id, allocation_date as work_day FROM crew_allocations
      WHERE status IN ('allocated','confirmed')
      AND allocation_date BETWEEN date(?, '-6 days') AND date(?)
      UNION ALL
      SELECT crew_member_id, work_date as work_day FROM timesheets
      WHERE work_date BETWEEN date(?, '-6 days') AND date(?)
    ) d GROUP BY crew_member_id
  `).all(today, today, today, today);

  const map = new Map();
  for (const r of rows) map.set(r.crew_member_id, r.days_worked);
  return map;
}

/**
 * Compute compliance status using pre-fetched batch fatigue data.
 * Same as getComplianceStatus but avoids per-member DB query for fatigue.
 */
function getComplianceStatusBatch(member, fatigueMap, referenceDate) {
  const today = referenceDate || new Date().toISOString().split('T')[0];

  const daysWorked = fatigueMap.get(member.id) || 0;
  const fatigueMaxDays = getConfig('fatigue_max_days', 5);
  const fatigueBlocked = daysWorked >= fatigueMaxDays;

  const expiryFields = [
    { field: 'tc_ticket_expiry', label: 'TC Ticket', required: !!member.tc_ticket },
    { field: 'ti_ticket_expiry', label: 'TI Ticket', required: !!member.ti_ticket },
    { field: 'white_card_expiry', label: 'White Card', required: !!member.white_card },
    { field: 'first_aid_expiry', label: 'First Aid', required: !!member.first_aid },
    { field: 'medical_expiry', label: 'Medical', required: !!member.medical_expiry },
  ];

  const warningDays = getConfig('ticket_expiry_warning_days', 30);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + warningDays);
  const soon30Str = soon.toISOString().split('T')[0];

  let allTicketsValid = true;
  let licenceValid = true;
  const expiredItems = [];
  const expiringItems = [];
  const missingItems = [];

  if (member.licence_type && member.licence_expiry) {
    if (member.licence_expiry < today) {
      licenceValid = false;
      expiredItems.push({ label: 'Licence', date: member.licence_expiry });
    } else if (member.licence_expiry <= soon30Str) {
      expiringItems.push({ label: 'Licence', date: member.licence_expiry });
    }
  } else if (member.licence_type && !member.licence_expiry) {
    missingItems.push('Licence expiry date');
  }

  for (const check of expiryFields) {
    const val = member[check.field];
    if (check.required && !val) missingItems.push(check.label + ' expiry date');
    if (val && val < today) {
      expiredItems.push({ label: check.label, date: val });
      allTicketsValid = false;
    } else if (val && val <= soon30Str) {
      expiringItems.push({ label: check.label, date: val });
    }
  }

  if (!member.phone) missingItems.push('Phone');
  if (!member.email) missingItems.push('Email');
  if (!member.employee_id) missingItems.push('Employee ID');

  const inductionComplete = member.induction_status === 'completed';
  const supervisorApproved = !!member.supervisor_approved;
  const isActive = !!member.active;
  const canAllocate = isActive && inductionComplete && allTicketsValid
    && licenceValid && !fatigueBlocked;

  return {
    isActive, canAllocate, inductionComplete, allTicketsValid, licenceValid,
    fatigueBlocked, daysWorked, supervisorApproved,
    missingDocs: missingItems.length > 0, missingItems, expiredItems, expiringItems,
  };
}

/**
 * Check if a TC level meets a job requirement.
 * supervisor > team_leader > intermediate > beginner.
 * Empty requirement means anything passes.
 * Also accepts legacy TCP/TGS values for backwards compatibility.
 */
function tcpLevelMeetsRequirement(workerLevel, requiredLevel) {
  if (!requiredLevel || requiredLevel === '') return true;
  if (!workerLevel || workerLevel === '') return false;
  const levels = { 'beginner': 1, 'intermediate': 2, 'team_leader': 3, 'supervisor': 4, 'TCP1': 1, 'TCP2': 2, 'TCP3': 3, 'TGS1': 1, 'TGS2': 2, 'TGS3': 3 };
  return (levels[workerLevel] || 0) >= (levels[requiredLevel] || 0);
}

/**
 * Run all allocation blocking checks.
 * Returns { allowed, blocks, warnings, overridable }.
 */
function checkAllocationBlocks(crewMemberId, jobId, allocationDate, startTime, endTime, excludeAllocId) {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(crewMemberId);
  if (!member) return { allowed: false, blocks: ['Crew member not found'], warnings: [], overridable: false };

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return { allowed: false, blocks: ['Job not found'], warnings: [], overridable: false };

  const compliance = getComplianceStatus(member, allocationDate);
  const blocks = [];
  const warnings = [];

  // Block 1: Worker must be active
  if (!compliance.isActive) {
    blocks.push(member.full_name + ' is inactive');
  }

  // Block 2: Induction must be completed
  if (!compliance.inductionComplete) {
    blocks.push(member.full_name + ': induction not completed (status: ' + (member.induction_status || 'pending') + ')');
  }

  // Block 3: Required competency (TC level)
  if (!tcpLevelMeetsRequirement(member.tcp_level, job.required_tcp_level)) {
    blocks.push(member.full_name + ' has ' + (member.tcp_level || 'no TC level') + ' but job requires ' + job.required_tcp_level);
  }

  // Block 4: Fatigue
  if (compliance.fatigueBlocked) {
    blocks.push('Fatigue block: ' + member.full_name + ' has worked ' + compliance.daysWorked + ' of last 7 days');
  }

  // Block 5: Overlapping shift (time conflict)
  const existingQuery = excludeAllocId
    ? `SELECT ca.id, ca.start_time, ca.end_time, j.job_number
       FROM crew_allocations ca JOIN jobs j ON ca.job_id = j.id
       WHERE ca.crew_member_id = ? AND ca.allocation_date = ?
       AND ca.status IN ('allocated','confirmed') AND ca.id != ?`
    : `SELECT ca.id, ca.start_time, ca.end_time, j.job_number
       FROM crew_allocations ca JOIN jobs j ON ca.job_id = j.id
       WHERE ca.crew_member_id = ? AND ca.allocation_date = ?
       AND ca.status IN ('allocated','confirmed')`;

  const existing = excludeAllocId
    ? db.prepare(existingQuery).all(crewMemberId, allocationDate, excludeAllocId)
    : db.prepare(existingQuery).all(crewMemberId, allocationDate);

  for (const ea of existing) {
    if (startTime < ea.end_time && ea.start_time < endTime) {
      blocks.push('Shift overlap: already on ' + ea.job_number + ' (' + ea.start_time + '-' + ea.end_time + ')');
    }
  }

  // Warnings (non-blocking)
  for (const exp of compliance.expiredItems) {
    warnings.push(member.full_name + ': ' + exp.label + ' expired ' + exp.date);
  }
  for (const exp of compliance.expiringItems) {
    warnings.push(member.full_name + ': ' + exp.label + ' expiring ' + exp.date);
  }
  if (!compliance.supervisorApproved) {
    warnings.push(member.full_name + ': not supervisor-approved');
  }
  if (compliance.missingDocs) {
    warnings.push(member.full_name + ': missing docs (' + compliance.missingItems.join(', ') + ')');
  }

  return {
    allowed: blocks.length === 0,
    blocks,
    warnings,
    overridable: true,
  };
}

module.exports = {
  getComplianceStatus,
  getComplianceStatusBatch,
  getBatchFatigue,
  tcpLevelMeetsRequirement,
  checkAllocationBlocks,
};
