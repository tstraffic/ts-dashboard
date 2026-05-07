// Helpers around the "is this employee inducted?" state.
// Inducted = passed both training modules AND signed the current SOP.
// Settable manually (admin checkbox) OR auto-set when all three records exist.
const { currentVersion: currentSopVersion } = require('./sop');

const REQUIRED_MODULES = ['employee_guide', 'tc_training_1'];

// Check if every required module has at least one passing completion for this employee.
function hasAllRequiredTraining(db, employeeId) {
  if (!employeeId) return false;
  const passes = db.prepare(`
    SELECT DISTINCT module FROM training_completions
    WHERE employee_id = ? AND passed = 1
  `).all(employeeId).map(r => r.module);
  return REQUIRED_MODULES.every(m => passes.includes(m));
}

function hasCurrentSopAck(db, crewMemberId) {
  if (!crewMemberId) return false;
  const row = db.prepare(
    'SELECT id FROM sop_acknowledgements WHERE crew_member_id = ? AND sop_version = ?'
  ).get(crewMemberId, currentSopVersion());
  return !!row;
}

// Auto-promote employees.inducted_at if (training + SOP) are both complete.
// Idempotent: skips if already set. method = 'in_person' | 'online'.
function maybeMarkInducted(db, employeeId, method) {
  if (!employeeId) return false;
  const emp = db.prepare('SELECT id, inducted_at, linked_crew_member_id FROM employees WHERE id = ?').get(employeeId);
  if (!emp) return false;
  if (emp.inducted_at) return false;
  if (!hasAllRequiredTraining(db, employeeId)) return false;
  if (!hasCurrentSopAck(db, emp.linked_crew_member_id)) return false;

  db.prepare(`
    UPDATE employees SET inducted_at = datetime('now'), inducted_method = ? WHERE id = ?
  `).run(method || 'auto', employeeId);
  return true;
}

module.exports = { REQUIRED_MODULES, hasAllRequiredTraining, hasCurrentSopAck, maybeMarkInducted };
