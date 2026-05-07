// Structured SOP / SWMS content. These are the "rich, mobile-friendly"
// versions workers actually read on the sign page — written in plain English,
// chunked into sections, with images. The original PDFs uploaded to
// /induction/admin/sop-documents stay as the legal record (paired here via
// `pdfFilenameMatch` so they auto-link to the rich version).
//
// Content is in /lib because it changes rarely and benefits from version
// control / code review / diffs. To force re-acknowledgement after a real
// content change, bump CURRENT_VERSION in lib/sop.js.

const SOPS = [
  {
    slug: 'preparing-for-safe-shift',
    title: 'Preparing for a Safe Shift',
    code: 'HSE 04.02.51',
    revision: '1',
    summary: 'How every shift starts — preparation, PPE, vehicle pre-start, and arriving on site ready to work safely.',
    pdfFilenameMatch: /04\.02\.51|safe.?shift/i,
    imageFolder: '/images/sop/safe-shift',
    sections: [
      {
        id: 'allocation',
        heading: '1. Allocation',
        body: 'Every shift starts with the job notification in Traff.io. Treat the notification as the start of the shift, not the moment you arrive on site.',
        items: [
          'When you receive a job notification, <strong>read it carefully</strong>: location, start time, scope, supervisor, client, TGS reference, and any site-specific notes.',
          '<strong>Respond promptly</strong> — accept or decline so Operations can fill the shift if you can\'t do it. Sitting on a notification is not an answer.',
          'If <strong>anything is unclear</strong> — site, scope, equipment, hours, comms — call your Operations Team straight away. Don\'t guess and don\'t turn up uncertain.',
          'Plan your travel: route, traffic, fuel, depot pickup if required. Build buffer time into your trip so a delay doesn\'t become a late arrival.',
        ],
        callout: {
          type: 'rule',
          text: 'A job you don\'t fully understand is a job you can\'t do safely. Pick up the phone and ask.',
        },
        image: { file: '01-allocation.jpg', alt: 'Checking the job in Traff.io', caption: 'Read the job in Traff.io carefully — every line of it.' },
      },
      {
        id: 'preparation',
        heading: '2. Preparation',
        body: 'Get yourself and your kit ready the day or night before. Mornings are no time to be hunting for gear.',
        items: [
          'Lay out <strong>all mandated PPE</strong> the night before — including any <strong>site-specific PPE</strong> noted on the job.',
          'Check your <strong>UHF/VHF radio is on charge</strong>. A flat radio at 5am is not a problem you can fix on site.',
          '<strong>Get a proper sleep</strong>. Fatigue is the single biggest risk in our industry.',
          'If you are <strong>fatigued, sick, or otherwise not fit for work</strong>, call your Operations Team immediately. Don\'t turn up impaired — we\'ll move the job, not you onto a site.',
        ],
        callout: {
          type: 'warning',
          text: 'You are not fit for work if you are fatigued, hungover, on medication that affects you, or unwell. Call Ops — don\'t come to site.',
        },
        image: { file: '02-preparation.jpg', alt: 'PPE laid out night before', caption: 'PPE laid out and radio on charge the night before.' },
      },
      {
        id: 'organisation',
        heading: '3. Organisation',
        body: 'Pack for the conditions you\'ll actually face — not the ones you hope for.',
        items: [
          '<strong>Check the weather forecast</strong> for your shift hours and the area you\'re working in.',
          'Pack PPE for the conditions: <strong>night whites</strong>, <strong>night wand</strong>, <strong>broad-brim hat</strong>, <strong>sunscreen</strong>, <strong>wet weather PPE</strong>, <strong>TC lights and spare batteries</strong>.',
          'If you\'re working remote or away from a depot, take spare batteries, spare lamps and any small consumables you might need.',
          'A small toolkit goes a long way: gaffer tape, zip ties, marker, a torch, and a notebook for site notes.',
        ],
        image: { file: '03-organisation.jpg', alt: 'Checking weather and packing kit', caption: '' },
      },
      {
        id: 'sustenance-and-hydration',
        heading: '4. Sustenance and Hydration',
        body: 'You can\'t concentrate for 10–12 hours on a roadside if you haven\'t eaten or had water.',
        items: [
          'Bring <strong>enough food and water for the full shift</strong> — and then some, because shifts often run over.',
          'Eat a <strong>balanced meal</strong> with carbs, protein, fat — not just energy drinks. Sustained focus comes from real food.',
          '<strong>Fill your water bottle</strong> before you leave. In hot weather, take an electrolyte sachet or sports drink to replace what you sweat out.',
          'Plan a couple of small snacks for between meal breaks — nuts, fruit, muesli bars. Low blood sugar is a near-miss waiting to happen.',
        ],
        callout: {
          type: 'warning',
          text: 'Dehydration impairs decision-making the same way fatigue does. On a hot job, drink before you\'re thirsty.',
        },
        image: { file: '04-sustenance.jpg', alt: 'Preparing food and water for shift', caption: '' },
      },
      {
        id: 'ppe',
        heading: '5. Personal Protective Equipment (PPE)',
        body: 'PPE is the last line of defence — but it only works if it\'s the right kit and you wear it properly.',
        items: [
          'Wear <strong>all PPE appropriate to the conditions</strong>: hi-vis day or night, hard hat, safety glasses, gloves, safety boots, sunscreen.',
          '<strong>Boots done up properly</strong> all the way to the top hooks. Loose laces or low-tied boots dramatically increase ankle injury risk on uneven ground.',
          'Hi-vis must be <strong>clean and not faded</strong>. A faded vest at night is the same as no vest at all.',
          'If anything is missing, damaged, or doesn\'t fit — <strong>contact Operations before you leave the depot</strong>. Do not go to site without proper PPE unless explicitly instructed.',
        ],
        image: { file: '05-ppe.jpg', alt: 'Boots laced properly', caption: 'Boots laced to the top — every shift, every site.' },
      },
      {
        id: 'punctuality',
        heading: '6. Punctuality',
        body: 'On time is late. Early is on time.',
        items: [
          '<strong>Arrive early.</strong> If you\'re "on time" you\'re late — there\'s no time to brief, set up, and start at your scheduled time if you roll up at the start time.',
          'Allow for <strong>unexpected delays</strong> — accidents on the freeway, road closures, weather, fuel stops. Plan a 15–20 minute buffer minimum.',
          'Be <strong>ready to start work</strong> at your scheduled time — bag packed, briefed, kit sorted, in position.',
          'If you\'re going to be delayed, <strong>call your supervisor immediately</strong>. Don\'t wait until you\'re already late.',
        ],
        callout: {
          type: 'rule',
          text: 'Arriving early and organised sets the tone for the whole shift — for you and the rest of the crew.',
        },
        image: { file: '06-punctuality.jpg', alt: 'Arriving on site early', caption: '' },
      },
      {
        id: 'vehicle-pre-start',
        heading: '7. Vehicle Pre-Start',
        body: 'Vehicle pre-start is non-negotiable. A failed component on a busy road is both a safety issue and a productivity disaster.',
        items: [
          'Walk around the vehicle and check: <strong>tyres (including spare), lights, beacons, indicators, mirrors, fluid leaks, fuel, AdBlue</strong>.',
          'Check <strong>load restraint</strong> — all signs, cones and equipment properly secured before you move.',
          'Inside: <strong>seatbelts, dash warnings, horn, wipers, washer fluid</strong>. Adjust your seat and mirrors before you drive off.',
          'Test your <strong>amber rotating beacons and arrow board</strong> if fitted. They must work before you leave the depot, not when you arrive.',
          '<strong>Submit your pre-start in Alloc8</strong> before you leave for site. No submission = no shift.',
        ],
        callout: {
          type: 'critical',
          text: 'If anything fails the pre-start, do not take the vehicle. Tag it out and call the depot.',
        },
        image: { file: '07-vehicle-pre-start.jpg', alt: 'Walking around vehicle pre-start check', caption: 'Walk-around, sign-off, then drive.' },
      },
      {
        id: 'job-requirements',
        heading: '8. Job Requirements',
        body: 'You\'ve checked yourself. Now check the job.',
        items: [
          '<strong>Read the TGS / TMP again</strong>: layout, sign sequence, taper lengths, speed limits, comms, special conditions.',
          '<strong>Cross-check your kit against the TGS.</strong> Every sign, cone, barrier, light, battery and any specialist gear (TMA, drop-deck, portable signals, VMS).',
          'Confirm any <strong>special PPE</strong> the client requires (e.g. some clients require fall arrest, gas monitors, ear defenders).',
          'If you\'re short anything you need to do the job safely — <strong>Stop and Escalate</strong>. Don\'t leave the depot improvising.',
        ],
        callout: {
          type: 'rule',
          text: 'Stop and Escalate is not a failure — it\'s the system working. Missing kit on site is a much bigger problem than a 10-minute delay at the depot.',
        },
        image: { file: '08-job-requirements.jpg', alt: 'Checking equipment against TGS', caption: '' },
      },
      {
        id: 'be-prepared',
        heading: '9. Be Prepared',
        body: 'A safe shift is built before the shift starts. The crew that prepares well runs a smooth site, gets home on time, and gets called back for the next job.',
        items: [
          'Allocation accepted, scope understood.',
          'Body and mind ready — rested, fed, hydrated, fit for work.',
          'PPE complete and in good condition.',
          'Vehicle pre-start passed and submitted.',
          'Equipment matches the TGS.',
          'On site early, in position, briefed and ready.',
        ],
        callout: {
          type: 'rule',
          text: 'Being prepared is the single biggest thing you control. Use it.',
        },
        image: { file: '09-be-prepared.jpg', alt: 'Crew briefing on site', caption: '' },
      },
    ],
  },
  // Placeholders for the remaining SOPs the user listed. They will be
  // authored in subsequent passes from the matching PDFs.
  // - 'stop-slow' (HSE 04.02.53)
  // - 'two-way-radio' (HSE 04.02.54)
  // - 'drop-deck' (HSE 04.02.61)
  // - 'swms' (last)
];

const BY_SLUG = Object.fromEntries(SOPS.map(s => [s.slug, s]));

function all() { return SOPS; }
function bySlug(slug) { return BY_SLUG[slug] || null; }

module.exports = { all, bySlug };
