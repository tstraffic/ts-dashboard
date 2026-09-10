// Match parsed E-Toll sections (tag numbers / licence plates) to vehicles.
// Pure: takes the vehicle rows in, no DB access. Tags match vehicles.toll_tag,
// plates match vehicles.rego (both normalised — the register spells plates
// 'ETR 82V' and 'ETR82V' interchangeably). The statement's reference label
// (e.g. TSTC006) is a fallback when the tag itself is unknown, and a hint for
// prefilling "Add vehicle". Duplicates flagged 'Verify' lose to Active rows;
// anything still ambiguous is left for the reviewer to choose.
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function pick(cands) {
  if (!cands.length) return { vehicleId: null, ambiguous: false };
  const active = cands.filter(v => v.status === 'Active');
  const pool = active.length ? active : cands;
  return pool.length === 1 ? { vehicleId: pool[0].id, ambiguous: false } : { vehicleId: null, ambiguous: true };
}

/**
 * @param sections [{ key, kind:'tag'|'plate', ref, label }]
 * @param vehicles [{ id, asset_id, fleet_id, rego, toll_tag, status }]
 * @returns { [key]: { vehicleId, how:'tag'|'plate'|'reference'|null, ambiguous, candidates:[], hint } }
 */
function matchSections(sections, vehicles) {
  const byTag = {}, byPlate = {}, byAsset = {};
  (vehicles || []).forEach(v => {
    const t = norm(v.toll_tag); if (t) (byTag[t] = byTag[t] || []).push(v);
    const p = norm(v.rego); if (p) (byPlate[p] = byPlate[p] || []).push(v);
    [v.asset_id, v.fleet_id].forEach(a => { const k = norm(a); if (k) (byAsset[k] = byAsset[k] || []).push(v); });
  });
  const slim = (v) => ({ id: v.id, asset_id: v.asset_id, rego: v.rego, status: v.status });
  const out = {};
  (sections || []).forEach(sec => {
    let cands = sec.kind === 'tag' ? (byTag[norm(sec.ref)] || []) : (byPlate[norm(sec.ref)] || []);
    let how = sec.kind;
    if (!cands.length && sec.label && byAsset[norm(sec.label)]) { cands = byAsset[norm(sec.label)]; how = 'reference'; }
    const r = pick(cands);
    const hintV = sec.label && byAsset[norm(sec.label)] ? byAsset[norm(sec.label)][0] : null;
    out[sec.key] = {
      vehicleId: r.vehicleId,
      how: r.vehicleId ? how : null,
      ambiguous: r.ambiguous,
      candidates: cands.map(slim),
      hint: hintV ? slim(hintV) : null,
    };
  });
  return out;
}

module.exports = { matchSections, norm };
