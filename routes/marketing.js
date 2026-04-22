// Marketing dashboard — Phase 1 + 2 UI.
// All numbers / tasks / approvals / activity items are illustrative
// placeholders that mirror Marketing-Dashboard-Mockup.html v4 and the
// Dashboard-Build-Spec.md. Tasks, approvals, comments, and the quick-ask
// form are NOT persisted yet — buttons are no-ops until the data model
// from spec §3 lands. Use this page as the visual contract for agency
// scoping; wire real sources afterwards.

const express = require('express');
const router = express.Router();

const data = {
  periodLabel: 'April 2026 · month-to-date',
  syncedAgo: '8 min ago',

  alerts: [
    { tone: 'bad',  text: '1 blog missed this month — reschedule' },
    { tone: 'warn', text: 'Employee advocacy: 5 below target (7/12)' },
    { tone: 'warn', text: '"event traffic management sydney" ▼ 3 positions' },
    { tone: 'bad',  text: 'Retainer hours over-pacing (95% used · 73% through month)' },
  ],

  kpis: [
    { label: 'Marketing leads',           value: '17',       split: '11 form · 6 phone', delta: '▲ 41% vs last month', tone: 'up' },
    { label: 'Cost per qualified lead',   value: '$128',     delta: '▼ 12% vs target',   tone: 'up',  target: 'Target: $145' },
    { label: 'Content delivered vs plan', value: '92%',      delta: '11 of 12 shipped',  tone: 'flat', target: 'Target: 100%' },
    { label: 'Spend this month',          value: '$10.8k',   valueSuffix: ' / $12k', pace: { fill: 90, mark: 73, leftLabel: 'spend 90%', rightLabel: 'month 73%' } },
  ],

  tasks: {
    mine: [
      { title: 'Review & approve Parramatta Council case study (v2)', from: 'Lisa (agency)', link: 'Parramatta TGS campaign', comments: 3, priority: 'high', due: 'Due tomorrow', dueUrgent: true },
      { title: 'Approve Google Ads budget increase (+$2,000)',        from: 'Tom (agency)',  link: 'Paid search campaign',   comments: 1, priority: 'med',  due: 'Due today',    dueUrgent: true },
      { title: 'Sign off Acknowledgement of Country video script',    from: 'Jess (internal)', note: 'cultural review cleared', comments: 5, priority: 'high', due: 'Fri 25 Apr' },
      { title: 'Send 3 recent tender wins for case study pipeline',   from: 'Lisa (agency)', note: 'need job codes + permissions', priority: 'med', due: 'Wed 30 Apr' },
    ],
    theirs: [
      { title: 'Book shoot day for controller recruitment video',          to: 'Lisa (agency)',  avatar: 'li', note: 'crew + location required',            priority: 'high', due: 'Tue 29 Apr' },
      { title: 'Draft May content calendar with safety + RAP themes',      to: 'Lisa (agency)',  avatar: 'li',                                               priority: 'high', due: 'Thu 1 May' },
      { title: 'Propose 3 regional LGA content pieces',                    to: 'Tom (agency)',   avatar: 'to', note: 'Newcastle, Wollongong, Central Coast', priority: 'med',  due: 'Mon 5 May' },
      { title: 'Reschedule missed blog "Why safety isn\'t a checkbox"',    to: 'Lisa (agency)',  avatar: 'li',                                               priority: 'med',  due: 'Fri 25 Apr' },
      { title: 'Lift employee advocacy participation from 7 → 12',         to: 'Jess (internal)', avatar: 'je', note: 'propose incentive structure',         priority: 'low',  due: 'End May' },
      { title: 'Site CRO review (leads conversion 0.8% — below B2B benchmark)', to: 'Mike (agency)', avatar: 'mk', note: 'audit + recommendations',          priority: 'high', due: 'Fri 9 May' },
      { title: 'Shortlist 2 Supply Nation partners for next shoot',        to: 'Lisa (agency)',  avatar: 'li', note: 'RAP alignment',                        priority: 'med',  due: 'Fri 9 May' },
    ],
  },

  approvals: [
    { type: 'BUDGET',     title: 'Google Ads April — top-up $2,000',          meta: 'Tom (agency) · Strong CPL ($128 vs $145 target); wants to scale.', dueText: 'today', dueTone: 'urgent' },
    { type: 'CONTENT',    title: 'Blog — "Western Sydney projects we\'re proud of"', meta: 'Lisa (agency) · Draft ready · 4 images pending sign-off.',  dueText: 'Fri 25 Apr' },
    { type: 'CASE STUDY', title: 'Parramatta Council TGS — final version',    meta: 'Council legal cleared · waiting on your logo + quote approval.',   dueText: 'Sat 26 Apr' },
    { type: 'CREATIVE',   title: 'LinkedIn ABM creative set (3 variants)',    meta: 'Tom (agency) · Live next Monday · needs your pick.',              dueText: 'Thu 5pm' },
  ],

  campaigns: [
    { name: 'Indigenous Engagement — Community Stories Q2', tag: 'RAP',         tagTone: 'indig', status: 'live', statusLabel: 'Live',    spendText: '$3,200 / $6,000',   progress: 53, reach: '18,400 reach' },
    { name: 'Google Ads — Traffic control NSW',             tag: 'PAID SEARCH', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$2,180 / $4,000',   progress: 55, reach: '312 clicks' },
    { name: 'LinkedIn ABM — Tier 1 civil contractors',      tag: 'PAID SOCIAL', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$1,420 / $3,000',   progress: 47, reach: '9,100 impressions' },
    { name: 'Case study launch — Parramatta Council TGS',   tag: 'BRAND',       tagTone: 'brand', status: 'plan', statusLabel: 'Planned', spendText: 'Launch 28 Apr',     progress: 20, reach: 'not yet live' },
    { name: 'Local SEO push — Western Sydney LGAs',         tag: 'SEO',         tagTone: 'seo',   status: 'live', statusLabel: 'Live',    spendText: 'Retainer',          progress: 70, reach: '7 pages live' },
    { name: 'Employer brand — Controller recruitment video',tag: 'BRAND',       tagTone: 'brand', status: 'prep', statusLabel: 'Prep',    spendText: 'Shoot 2 May',       progress: 15, reach: 'not yet live' },
  ],

  social: {
    stats: [
      { k: 'LinkedIn eng.', v: '4.8%',  d: '▲ 1.2pp',     dTone: 'up',    target: 'Target: 3.6%' },
      { k: 'Posts / mo',    v: '16 / 16', d: 'on plan',    dTone: 'up',    target: 'Target: 16' },
      { k: 'Advocacy',      v: '7 / 12', d: 'below target', dTone: 'warn', target: 'Target: 12 staff' },
    ],
    sparkline: { points: '0,62 60,55 120,48 180,36 240,24 300,14', months: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'] },
    followersLabel: 'Follower growth — last 6 months (1,276)',
  },

  leadSource: [
    { label: 'Organic search',   last: 7, first: 4 },
    { label: 'Google Ads',       last: 4, first: 2 },
    { label: 'LinkedIn organic', last: 3, first: 6 },
    { label: 'LinkedIn Ads',     last: 2, first: 3 },
    { label: 'Referral',         last: 1, first: 1 },
    { label: 'Direct',           last: 0, first: 1 },
  ],

  regions: [
    { label: 'Sydney metro',           n: 8, pct: 47, barPct: 100 },
    { label: 'Western Sydney',         n: 4, pct: 24, barPct: 50 },
    { label: 'Newcastle / Hunter',     n: 2, pct: 12, barPct: 25 },
    { label: 'Illawarra',              n: 2, pct: 12, barPct: 25 },
    { label: 'Central Coast',          n: 1, pct: 6,  barPct: 12 },
    { label: 'Regional / other NSW',   n: 0, pct: 0,  barPct: 0 },
    { label: 'Unknown / unattributed', n: 0, pct: 0,  barPct: 0 },
  ],

  reviews: {
    stars: '4.7',
    totalText: 'from 68 reviews',
    rows: [
      { k: 'New reviews this month',        v: '12', delta: '▲ 5' },
      { k: 'Response rate (owner)',         v: '94%' },
      { k: '5-star share',                  v: '82%' },
      { k: 'Google Business Profile views', v: '3,410' },
      { k: 'Direction / call clicks',       v: '148' },
    ],
    footer: 'Target: 5 new reviews/month, 100% owner response within 48 hrs.',
  },

  content: {
    cards: [
      { num: '3 / 4', cat: 'Blogs',           sub: 'of plan' },
      { num: '2 / 2', cat: 'Case studies',    sub: 'of plan' },
      { num: '1 / 1', cat: 'Videos',          sub: 'of plan' },
      { num: '148',   cat: 'Photos captured', sub: '3 shoots' },
    ],
    items: [
      { title: '"How councils reduce risk with certified TGS plans"', meta: 'Blog · Shipped 8 Apr',               comments: 2, avatar: 'li', status: 'live',    statusLabel: 'Live' },
      { title: '"TMP vs TGS — what councils actually need"',          meta: 'Blog · Shipped 15 Apr',              comments: 0, avatar: 'li', status: 'live',    statusLabel: 'Live' },
      { title: '"Western Sydney projects we\'re proud of"',           meta: 'Blog · Awaiting your approval · 26 Apr', comments: 4, avatar: 'li', status: 'plan', statusLabel: 'Review' },
      { title: '"Why safety isn\'t a checkbox"',                      meta: 'Blog · Reschedule',                  comments: 2, avatar: 'li', status: 'blocked', statusLabel: 'Blocked', missed: true },
      { title: 'Parramatta Council — roundabout upgrade case study',  meta: 'Case study · Awaiting your approval · 28 Apr', comments: 6, avatar: 'li', status: 'plan', statusLabel: 'Review' },
      { title: 'Ausgrid — after-hours lane closure case study',       meta: 'Case study · Shipped 12 Apr',        comments: 1, avatar: 'to', status: 'live',    statusLabel: 'Live' },
      { title: 'Acknowledgement of Country — website video',          meta: 'Video · Edit · 30 Apr',              comments: 5, avatar: 'je', status: 'plan',    statusLabel: 'In edit' },
      { title: 'Team spotlight — senior TC Darren (15 years)',        meta: 'Photo + social · Shipped 20 Apr',    comments: 0, avatar: 'li', status: 'live',    statusLabel: 'Live' },
    ],
  },

  seo: {
    keywords: [
      { kw: 'traffic control sydney',               pos: '#6',  chg: '▲ 3',        chgTone: 'up'   , volume: '1,900' },
      { kw: 'traffic management nsw',               pos: '#9',  chg: '▲ 2',        chgTone: 'up'   , volume: '1,300' },
      { kw: 'TMP plan sydney',                      pos: '#4',  chg: '▲ 5',        chgTone: 'up'   , volume: '720'   },
      { kw: 'traffic guidance scheme newcastle',    pos: '#12', chg: '▲ 4',        chgTone: 'up'   , volume: '390'   },
      { kw: 'traffic controllers western sydney',   pos: '#8',  chg: '—',          chgTone: 'flat' , volume: '580'   },
      { kw: 'event traffic management sydney',      pos: '#22', chg: '▼ 3',        chgTone: 'down' , volume: '260'   },
      { kw: 'aboriginal owned traffic management',  pos: '—',   chg: 'new target', chgTone: 'flat' , volume: '140', tag: 'RAP', tagTone: 'indig' },
    ],
    footer: '7 of 12 target keywords on page 1. Domain authority 22 (+3 MoM). Strategic keyword (RAP) tracked even at low volume.',
  },

  agency: [
    { lbl: 'Deliverables shipped on time',  val: '11 / 12 · 92%',         tone: 'good', pace: { fill: 92, tone: 'good' } },
    { lbl: 'Retainer hours used',           val: '38 / 40 hrs',           tone: 'warn', pace: { fill: 95, mark: 73, tone: 'warn' } },
    { lbl: '',                              val: '↑ over-pacing — 95% hours used, 73% through month', tone: 'warn', note: true },
    { lbl: 'Average response time',         val: '3.2 hrs',               tone: 'good' },
    { lbl: 'Monthly report delivered',      val: 'On time (day 3)',       tone: 'good' },
    { lbl: 'Scope changes this month',      val: '1 (approved)',          tone: 'neutral' },
    { lbl: 'Invoice vs. retainer',          val: '$8,000 / $8,000 · match', tone: 'good' },
  ],

  funnel: [
    { label: 'Website visits', value: '2,148', sub: 'organic + paid',           conv: '0.8%',  convTone: 'weak', isWin: false },
    { label: 'Leads',          value: '17',    sub: 'form + call',              conv: '53%',                    isWin: false },
    { label: 'Opportunities',  value: '9',     sub: 'qualified',                conv: '22%',                    isWin: false },
    { label: 'Won',            value: '2',     sub: '$84k TCV · YTD $342k',                                     isWin: true  },
  ],

  funnelNote: 'Bottleneck: site conversion 0.8% — below 1.5% B2B benchmark. Ask agency for CRO review before scaling paid traffic. Later stages look healthy.',

  activity: [
    { avatar: 'to', text: '<strong>Tom (agency)</strong> requested a $2,000 budget top-up on <strong>Google Ads — Traffic control NSW</strong>. Awaiting your approval.', when: '12 min ago' },
    { avatar: 'li', text: '<strong>Lisa (agency)</strong> moved <strong>"Western Sydney projects we\'re proud of"</strong> to Awaiting approval.', when: '48 min ago' },
    { avatar: 'sa', text: '<strong>You</strong> commented on the Parramatta case study: <em>"Use the wide shot from page 3 as the hero."</em>', when: '2 hr ago' },
    { avatar: 'je', text: '<strong>Jess</strong> uploaded the Acknowledgement of Country script · cultural review cleared by Uncle David.', when: '3 hr ago' },
    { avatar: 'to', text: '3 new leads from <strong>Google Ads</strong> (1 form, 2 phone). Enquiries routed to sales inbox.', when: '5 hr ago' },
    { avatar: 'mk', text: '<strong>Mike (agency)</strong> shipped SEO update: "traffic guidance scheme newcastle" improved by 4 positions.', when: 'Yesterday' },
    { avatar: 'li', text: '<strong>Lisa (agency)</strong> shipped blog: "TMP vs TGS — what councils actually need." Published on LinkedIn + site.', when: '2 days ago' },
    { avatar: 'sa', text: '<strong>You</strong> approved invoice $8,000 · April retainer.', when: '2 days ago' },
  ],

  subNav: {
    daily: [
      { label: 'Overview',           href: '#sec-top',       active: true },
      { label: 'Tasks & approvals',  href: '#sec-tasks',     badge: '4', badgeTone: 'warn' },
    ],
    work: [
      { label: 'Campaigns', href: '#sec-campaigns', badge: '6' },
      { label: 'Content',   href: '#sec-content',   badge: '9' },
      { label: 'Leads',     href: '#sec-leads',     badge: '17', badgeTone: 'ghost' },
    ],
    performance: [
      { label: 'SEO',     href: '#sec-seo' },
      { label: 'Social',  href: '#sec-social' },
      { label: 'Reviews', href: '#sec-reviews', badge: '12' },
    ],
    manage: [
      { label: 'Agency',          href: '#sec-agency' },
      { label: 'Budget',          href: '#sec-top' },
      { label: 'Brand & assets',  href: '#sec-content' },
    ],
  },
};

router.get('/', (req, res) => {
  res.render('marketing', {
    title: 'Marketing',
    currentPage: 'marketing',
    data,
  });
});

module.exports = router;
