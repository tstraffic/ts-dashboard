// Traffic Control Site Safety Audit — FORM-663 v1.0
// Section/question catalog. Each question has a stable key (e.g. "1.1", "4.8")
// so responses_json can store { "1.1": { checked: true, na: false, notes: "..." }, ... }

const AUDIT_SECTIONS = [
  {
    key: '1',
    title: 'Pre-start Documentation',
    items: [
      'Current approved TGS / TCP / TMP / CTMP available on site',
      'Plan matches actual work activity being undertaken',
      'SWMS / risk assessment available and relevant to task',
      'Relevant permits / approvals in place',
      'Road Occupancy Licence or client approval in place where required',
      "Crew briefed on today's staging and traffic control arrangement",
      'Pre-start / toolbox completed',
      'Emergency contacts available',
      'After-hours / night works requirements addressed where relevant',
    ],
  },
  {
    key: '2',
    title: 'Competency and Authorisation',
    items: [
      'Traffic controllers hold the required current tickets / competencies',
      'Implementers / supervisors are competent for the traffic setup in use',
      'Workers understand their assigned positions and responsibilities',
      'Traffic controllers are formally appointed where directing traffic is required',
      'Suitable supervision is present on site',
      'Visitor / subcontractor induction completed if applicable',
    ],
  },
  {
    key: '3',
    title: 'PPE and Worker Presentation',
    items: [
      'Hi-vis clothing compliant and in good condition',
      'Hard hats worn where required',
      'Safety boots worn',
      'Radios / communication devices available and functioning',
      'Stop-slow bats / lights in good condition where used',
      'PPE suitable for weather and site conditions',
      'Workers appear fit for work and not fatigued',
    ],
  },
  {
    key: '4',
    title: 'Site Setup Against Plan',
    items: [
      'Traffic control layout matches approved drawing',
      'Signs installed in correct sequence',
      'Signs installed at correct spacing',
      'Signs are facing approaching traffic correctly',
      'Signs are clean, visible, and not damaged',
      'Covers used correctly on irrelevant signs',
      'Tapers are correct length and shape',
      'Cones / bollards / delineation installed correctly',
      'Barriers installed where shown on plan',
      'Plant access / work zone separation is maintained',
      'Pedestrian path is maintained or detour provided',
      'Cyclist management addressed where relevant',
      'Side streets / driveways managed correctly',
      'Speed zoning implemented as approved',
      'Temporary traffic signals / portable lights operating correctly if used',
      'Arrow boards / VMS / lighting towers positioned correctly if used',
    ],
  },
  {
    key: '5',
    title: 'Safety of the Work Zone',
    items: [
      'Work area clearly separated from live traffic',
      'Adequate buffer / safety space maintained',
      'No exposed hazards within pedestrian or traffic path',
      'Excavations, edge drops, and open pits protected',
      'Materials and equipment stored safely',
      'No trip hazards in pedestrian route',
      'Plant movements controlled and visible',
      'Reversing controls in place where required',
      'Access/egress for workers and vehicles is safe',
      'Public protected from moving plant and site activities',
    ],
  },
  {
    key: '6',
    title: 'Traffic Controller Operations',
    items: [
      'Controllers positioned safely and visibly',
      'Controllers have clear sight distance to approaching traffic',
      'No controller standing in an unsafe location',
      'Baton / hand signals / verbal commands used correctly',
      'Traffic released in a controlled and coordinated manner',
      'Queue lengths monitored',
      'Radios functioning between controllers',
      'Heavy vehicles / oversized vehicles managed safely',
      'Emergency vehicles can be accommodated',
      'No distraction from phones or non-work activity',
    ],
  },
  {
    key: '7',
    title: 'Vehicle and Equipment Checks',
    items: [
      'Traffic vehicles parked legally and safely',
      'Flashing lights working where fitted',
      'Utes / TMA / trucks positioned as per plan',
      'TMA used where required and in correct location',
      'Arrow board functioning and displaying correct mode',
      'VMS message correct and legible if used',
      'Portable lighting adequate for night works',
      'Spare signs / cones secured properly',
      'Equipment free of obvious damage',
      'Fuel / battery / charging adequate for shift',
    ],
  },
  {
    key: '8',
    title: 'Pedestrian and Public Interface',
    items: [
      'Safe pedestrian route maintained',
      'Disability access considered and maintained where possible',
      'Footpaths not blocked without approved diversion',
      'Temporary crossings safe and clear',
      'Public information signs visible where needed',
      'Nearby residents / businesses access maintained or controlled',
      'Bus stops / school zones / public interfaces managed appropriately',
    ],
  },
  {
    key: '9',
    title: 'Environmental and Site Conditions',
    items: [
      'Weather conditions considered in control setup',
      'Wind has not affected signs or delineation',
      'Dust, mud, water, or debris not impacting road users',
      'Lighting adequate for dawn, dusk, or night works',
      'Sun glare or blind spots considered',
      'Drainage / runoff not creating hazards',
    ],
  },
  {
    key: '10',
    title: 'Compliance and Housekeeping',
    items: [
      'Setup complies with approved plan and site conditions',
      'Changes to setup formally assessed and authorised',
      'Outdated or redundant signs removed / covered',
      'Site kept tidy throughout shift',
      'Audit findings recorded clearly',
      'Non-conformances escalated promptly',
      'Corrective actions assigned to responsible person',
      'Re-inspection completed after rectification if needed',
    ],
  },
  {
    key: '11',
    title: 'Close-out / Pack-up',
    items: [
      'Traffic control removed in safe sequence',
      'No signs left behind incorrectly',
      'Road / footpath left safe for public use',
      'Temporary devices removed when no longer needed',
      'Final drive-through / walk-through completed',
      'Any incidents, complaints, or near misses recorded',
      'Photos taken of final condition if required',
    ],
  },
];

// Group sections into the 6 scoring areas shown on the audit form summary
const SCORE_GROUPS = [
  { label: 'Documentation',            sectionKeys: ['1'] },
  { label: 'Setup compliance',         sectionKeys: ['4', '10'] },
  { label: 'Worker competency / PPE',  sectionKeys: ['2', '3'] },
  { label: 'Traffic operations',       sectionKeys: ['6'] },
  { label: 'Public safety',            sectionKeys: ['5', '8', '9'] },
  { label: 'Equipment / vehicles',     sectionKeys: ['7'] },
  { label: 'Housekeeping / close-out', sectionKeys: ['11'] },
];

function itemKey(sectionKey, idx) {
  return `${sectionKey}.${idx + 1}`;
}

/**
 * Compute scoring for a given responses object.
 * Scoring rule: checked (pass) counts toward score; N/A excluded from totals;
 * unchecked non-N/A = fail.
 */
function computeScore(responses) {
  responses = responses || {};
  const groups = SCORE_GROUPS.map(g => {
    let score = 0, max = 0;
    for (const secKey of g.sectionKeys) {
      const section = AUDIT_SECTIONS.find(s => s.key === secKey);
      if (!section) continue;
      section.items.forEach((_, idx) => {
        const key = itemKey(secKey, idx);
        const r = responses[key] || {};
        if (r.na) return;
        max++;
        if (r.checked) score++;
      });
    }
    return { label: g.label, score, max, percent: max ? Math.round((score / max) * 100) : 0 };
  });
  const total = groups.reduce((a, g) => a + g.score, 0);
  const max = groups.reduce((a, g) => a + g.max, 0);
  const percent = max ? Math.round((total / max) * 100) : 0;
  return { groups, total, max, percent };
}

module.exports = { AUDIT_SECTIONS, SCORE_GROUPS, itemKey, computeScore };
