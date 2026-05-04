// Plan → Sub-Plans status rollup. The parent's stored compliance.status
// is just a cached projection of its sub-plans' individual statuses, so
// the existing list-view filters and badge counters keep working.
//
// Precedence:
//   rejected > expired > approved (all) > submitted (all) > started > not_started

const PREFIX_MAP = {
  traffic_guidance: 'TSTGS',
  road_occupancy:   'TSROL',
  rol:              'TSROL',
  council_permit:   'TSCA',
  tmp_approval:     'TSTMP',
  swms_review:      'TSSWMS',
  insurance:        'TSINS',
  induction:        'TSIND',
  environmental:    'TSENV',
  utility_clearance:'TSUC',
  spa:              'TSSPA',
  sza:              'TSSZA',
  bus_approval:     'TSBA',
  police_notification:'TSPN',
  letter_drop:      'TSLD',
  other:            'TSOTH',
};

function expectedPrefix(itemType) {
  return PREFIX_MAP[itemType] || 'TSREF';
}

// Returns the rolled-up status string for a parent given its sub-plan rows.
// Rows shape: { status, expiry_date }
function rollupStatus(subPlans, today) {
  if (!subPlans || subPlans.length === 0) return 'not_started';
  const t = today || new Date().toISOString().split('T')[0];

  if (subPlans.some(s => s.status === 'rejected')) return 'rejected';
  if (subPlans.some(s => s.expiry_date && s.expiry_date < t && s.status !== 'expired')) {
    // Past-expiry without an explicit expired status still counts as expired at
    // the parent level — surfaces stale plans that nobody clicked through.
    return 'expired';
  }
  if (subPlans.some(s => s.status === 'expired')) return 'expired';
  if (subPlans.every(s => s.status === 'approved')) return 'approved';
  if (subPlans.every(s => s.status === 'approved' || s.status === 'submitted')) return 'submitted';
  return 'started';
}

// Recompute and persist a parent's status from its sub-plans. Safe to call
// after any sub-plan change; no-op if planId doesn't refer to a parent.
function syncParentStatus(db, planId) {
  const parent = db.prepare("SELECT id FROM compliance WHERE id = ? AND parent_id IS NULL AND plan_number IS NOT NULL").get(planId);
  if (!parent) return null;
  const subs = db.prepare("SELECT status, expiry_date FROM compliance WHERE parent_id = ?").all(planId);
  const status = rollupStatus(subs);
  db.prepare("UPDATE compliance SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, planId);
  return status;
}

// Computes the next plan_number for a brand-new parent. Considers both
// existing parent plan_numbers AND legacy `reference_number` numeric
// suffixes — keeps the global counter monotonic across the old flat-row
// world and the new hierarchy. Floor 3000 only kicks in for an empty DB.
function nextPlanNumber(db) {
  const tailRe = /^TS[A-Z]+(\d+)(?:-\d+)?$/;
  let max = 3000;

  const planRows = db.prepare("SELECT plan_number FROM compliance WHERE plan_number IS NOT NULL").all();
  planRows.forEach(r => { if (r.plan_number > max) max = r.plan_number; });

  const refRows = db.prepare("SELECT reference_number FROM compliance WHERE reference_number IS NOT NULL AND reference_number != ''").all();
  refRows.forEach(r => {
    const m = (r.reference_number || '').match(tailRe);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  });

  return max + 1;
}

// Builds a sub-plan reference: TS<TYPE><parent.plan_number>-<seq> where seq
// is the per-type counter within that parent.
function buildSubPlanRef(parentPlanNumber, itemType, seq) {
  return expectedPrefix(itemType) + parentPlanNumber + '-' + seq;
}

// Next available per-type sequence within a parent. Counts existing
// sub-plans of the same type and returns max+1 (so deletes don't reuse
// numbers — refs stay stable for downstream references).
function nextSubPlanSeq(db, parentId, itemType) {
  const rows = db.prepare("SELECT reference_number FROM compliance WHERE parent_id = ? AND item_type = ? AND reference_number IS NOT NULL").all(parentId, itemType);
  const tailRe = /-(\d+)$/;
  let max = 0;
  rows.forEach(r => {
    const m = (r.reference_number || '').match(tailRe);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  });
  return max + 1;
}

module.exports = {
  PREFIX_MAP,
  expectedPrefix,
  rollupStatus,
  syncParentStatus,
  nextPlanNumber,
  buildSubPlanRef,
  nextSubPlanSeq,
};
