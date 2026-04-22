// Marketing dashboard — Phase 1.
// All numbers are illustrative placeholders that mirror the mockup shared
// with the agency (see Marketing Brief & SOW §10). The agency will agree on
// how each panel gets populated — manual entry, monthly report, or API —
// and a follow-up PR will replace this inline object with real sources.

const express = require('express');
const router = express.Router();

const data = {
  periodLabel: 'April 2026 · month-to-date',

  kpis: [
    { label: 'Marketing-attributed leads', value: '17',     delta: '▲ 41% vs last month', tone: 'up' },
    { label: 'Cost per qualified lead',    value: '$128',   delta: '▼ 12% vs target',     tone: 'up' },
    { label: 'Website organic sessions',   value: '2,148',  delta: '▲ 23% MoM',           tone: 'up' },
    { label: 'LinkedIn followers',         value: '1,276',  delta: '▲ 8.4% MoM',          tone: 'up' },
    { label: 'Content delivered vs plan',  value: '92%',    delta: 'on track',            tone: 'flat' },
  ],

  campaigns: [
    { name: 'Indigenous Engagement — Community Stories Q2', tag: 'RAP',         tagTone: 'indig', status: 'live', statusLabel: 'Live',    spendText: '$3,200 / $6,000',   progress: 53, reach: '18,400 reach' },
    { name: 'Google Ads — Traffic control NSW',             tag: 'Paid search', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$2,180 / $4,000',   progress: 55, reach: '312 clicks' },
    { name: 'LinkedIn ABM — Tier 1 civil contractors',      tag: 'Paid social', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$1,420 / $3,000',   progress: 47, reach: '9,100 impressions' },
    { name: 'Case study launch — Parramatta Council TGS',   tag: 'Brand',       tagTone: 'brand', status: 'plan', statusLabel: 'Planned', spendText: 'Launch 28 Apr',     progress: 20, reach: '—' },
    { name: 'Local SEO push — Western Sydney LGAs',         tag: 'SEO',         tagTone: 'seo',   status: 'live', statusLabel: 'Live',    spendText: 'Ongoing retainer',  progress: 70, reach: '7 pages live' },
    { name: 'Employer brand — Controller recruitment video',tag: 'Brand',       tagTone: 'brand', status: 'prep', statusLabel: 'Prep',    spendText: 'Shoot 2 May',       progress: 15, reach: '—' },
  ],

  social: {
    stats: [
      { k: 'LinkedIn eng.',      v: '4.8%',   d: '▲ 1.2pp',    dTone: 'up' },
      { k: 'Posts / month',      v: '16 / 16', d: 'on plan',   dTone: 'up' },
      { k: 'Employee advocacy',  v: '7 staff', d: 'target 12', dTone: 'muted' },
    ],
    sparkline: { points: '0,62 60,55 120,48 180,36 240,24 300,14', months: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'] },
  },

  content: {
    cards: [
      { num: '3 / 4', cat: 'Blogs',           sub: 'of plan' },
      { num: '2 / 2', cat: 'Case studies',    sub: 'of plan' },
      { num: '1 / 1', cat: 'Videos',          sub: 'of plan' },
      { num: '148',   cat: 'Photos captured', sub: '3 shoots' },
    ],
    items: [
      { title: '"How councils reduce risk with certified TGS plans"', meta: 'Blog · Draft · due 26 Apr' },
      { title: 'Parramatta Council — roundabout upgrade case study',  meta: 'Case study · Review · due 28 Apr' },
      { title: 'Acknowledgement of Country — website video',          meta: 'Video · Edit · due 30 Apr' },
      { title: 'Team spotlight — senior TC Darren (15 years)',        meta: 'Photo + social · Scheduled 25 Apr' },
    ],
  },

  seo: {
    keywords: [
      { kw: 'traffic control sydney',            pos: '#6',  chg: '▲ 3',         chgTone: 'up',   volume: '1,900' },
      { kw: 'traffic management nsw',            pos: '#9',  chg: '▲ 2',         chgTone: 'up',   volume: '1,300' },
      { kw: 'TMP plan sydney',                   pos: '#4',  chg: '▲ 5',         chgTone: 'up',   volume: '720' },
      { kw: 'traffic guidance scheme newcastle', pos: '#12', chg: '▲ 4',         chgTone: 'up',   volume: '390' },
      { kw: 'traffic controllers western sydney',pos: '#8',  chg: '—',           chgTone: 'flat', volume: '580' },
      { kw: 'event traffic management sydney',   pos: '#22', chg: '▼ 3',         chgTone: 'down', volume: '260' },
      { kw: 'aboriginal owned traffic management', pos: '—', chg: 'new target',  chgTone: 'flat', volume: '140' },
    ],
    footer: { onPageOne: 7, totalTargets: 12, domainAuthority: 22, daDelta: '+3 MoM' },
  },

  funnel: [
    { label: 'Website visits',           value: '2,148', sub: 'organic + paid',      tone: 'brand-dark' },
    { label: 'Enquiries',                value: '17',    sub: 'form + call tracking', tone: 'brand-mid' },
    { label: 'Qualified opportunities',  value: '9',     sub: 'real tender / RFQ',    tone: 'brand-light' },
    { label: 'Won (this month)',         value: '2',     sub: 'est. $84k TCV',        tone: 'emerald' },
  ],

  evidence: [
    { k: 'Indigenous engagement evidence', v: '5 pieces',      d: 'tender-ready' },
    { k: 'Case study library',             v: '4 live',        d: 'target 12 by Q4' },
    { k: 'RAP progress',                   v: 'Reflect — 60%', d: 'submit by Oct' },
  ],
};

router.get('/', (req, res) => {
  res.render('marketing', {
    title: 'Marketing',
    currentPage: 'marketing',
    data,
  });
});

module.exports = router;
