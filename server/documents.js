'use strict';

// "Getting your documents": a personal, ordered how-to for the IDs a young
// person is missing, adjusted for age, state (Oregon vs. Clark County, WA),
// income, and history (foster care, reentry, immigration, homelessness,
// violence). Links point to official agencies; fees and rules change, so
// every guide tells people to confirm with the office.

const { deriveTags } = require('./matcher');

const L = {
  orBirth: { label: 'Oregon: order a birth certificate (OHA)', url: 'https://www.oregon.gov/oha/ph/birthdeathcertificates/pages/orderbirthcertificate.aspx' },
  waBirthNoFee: { label: 'Washington: free birth certificates for people experiencing homelessness', url: 'https://doh.wa.gov/licenses-permits-and-certificates/vital-records/vital-records-no-fee-specific-circumstances' },
  waVital: { label: 'Washington Department of Health — vital records', url: 'https://doh.wa.gov/licenses-permits-and-certificates/vital-records' },
  otherState: { label: 'Born in another state? Where to write (CDC)', url: 'https://www.cdc.gov/nchs/w2w/index.htm' },
  ssa: { label: 'Social Security card (free)', url: 'https://www.ssa.gov/number-card' },
  orDmv: { label: 'Oregon DMV', url: 'https://www.oregon.gov/odot/dmv' },
  waDol: { label: 'Washington Department of Licensing', url: 'https://dol.wa.gov' },
  orAcp: { label: 'Oregon Address Confidentiality Program', url: 'https://www.doj.state.or.us/crime-victims/victims-services/address-confidentiality-program-acp/' },
  ohp: { label: 'Apply for OHP (Oregon Health Plan)', url: 'https://benefits.oregon.gov' },
  waHealth: { label: 'Washington Apple Health', url: 'https://www.wahealthplanfinder.org' },
  uscis: { label: 'USCIS — replace immigration documents', url: 'https://www.uscis.gov' },
  ged: { label: 'GED transcripts', url: 'https://ged.com' },
  ilp: { label: 'Oregon Independent Living Program (foster youth)', url: 'https://www.oregon.gov/odhs/children-youth-families/pages/independent-living.aspx' },
};

const CORE = ['birth_cert', 'ssn_card', 'state_id'];

function context(p) {
  const tags = deriveTags(p);
  const v = p.vulnerabilities || [];
  const hh = p.household || {};
  return {
    state: p.county === 'clark' ? 'WA' : 'OR',
    stateKnown: !!p.county && p.county !== 'other',
    minor: p.age != null && p.age < 18,
    ageKnown: p.age != null,
    lowIncome: tags.includes('low_income'),
    unhoused: tags.includes('unhoused'),
    foster: tags.includes('foster'),
    reentry: v.includes('reentry') || p.housing === 'institution',
    justice: tags.includes('justice'),
    immigrant: tags.includes('immigrant'),
    dv: tags.includes('dv') || tags.includes('trafficking') || (hh.flags || []).includes('unsafe_member'),
    hasChildren: (hh.members || []).includes('child') || (p.family || []).includes('has_children'),
    noPhone: v.includes('no_phone'),
    wantsSchoolOrWork: (p.needs || []).some((n) => n === 'education' || n === 'employment'),
  };
}

// Which documents to cover. Nothing is assumed missing unless the youth said
// so, asked for ID help, or said they lack ID.
function missingDocuments(p) {
  const have = new Set(p.documents || []);
  const answered = have.size > 0;
  const none = have.has('none');
  const asked = (p.needs || []).includes('id_documents') || (p.vulnerabilities || []).includes('no_id');
  if (!answered && !asked) return [];
  const c = context(p);
  const lacks = (d) => none || (answered ? !have.has(d) : true);
  const out = CORE.filter(lacks);
  if (c.unhoused && lacks('proof_address') && (answered || asked)) out.push('proof_address');
  if (answered && lacks('insurance')) out.push('insurance');
  if (answered && c.wantsSchoolOrWork && lacks('school_records')) out.push('school_records');
  if (c.immigrant && answered && lacks('immigration')) out.push('immigration');
  return out;
}

const bullet = (cond, text) => (cond ? [text] : []);

function birthCert(c) {
  const steps = [];
  const links = [];
  if (c.state === 'WA') {
    steps.push('If you were born in Washington: order from the Washington Department of Health (online, by mail, or through VitalChek — the state’s only approved vendor).');
    links.push(L.waVital);
    if (c.unhoused) {
      steps.push('Experiencing homelessness and born in Washington? It can be free — a homeless service provider or agency sends the request for you with a letter on their letterhead. Ask your case manager or shelter.');
      links.push(L.waBirthNoFee);
    }
  } else {
    steps.push('If you were born in Oregon: order from the Oregon Center for Health Statistics online, by phone, by mail, or through VitalChek. Avoid other websites that charge extra.');
    links.push(L.orBirth);
    steps.push('County health offices can only issue certificates for the first few months after a birth — for anyone older, order from the state.');
  }
  steps.push('Born in another state: order from that state’s vital records office.');
  links.push(L.otherState);
  steps.push('Born outside the U.S.: a passport from your home country, a consular ID, or U.S. citizenship/naturalization papers can often prove who you are instead — see the immigration step if it applies.');
  const tips = [
    ...bullet(c.minor || !c.ageKnown, 'Under 18? Only certain people can order a birth record (you, a parent, a legal guardian, and some others). A caseworker, shelter staff, or attorney can help show you’re eligible, or someone eligible can sign a notarized permission form.'),
    ...bullet(c.lowIncome || c.unhoused, 'Can’t afford the fee? Ask a case manager, 211, or a youth drop-in center — many keep vouchers for birth certificates and IDs.'),
    ...bullet(c.foster, 'Current or former foster youth: your caseworker or Independent Living Program must help you get your birth certificate, Social Security card, and state ID before you leave care — ask for them now.'),
    ...bullet(c.reentry, 'Getting out of jail, prison, or OYA? Ask your release counselor or PO — facilities can often order your birth certificate and Social Security card before release.'),
    ...bullet(c.dv, 'For safety, have it mailed somewhere safe. Oregon’s Address Confidentiality Program gives survivors a free substitute address to use on documents.'),
    ...bullet(c.noPhone, 'Online and phone orders use an identity quiz. No phone? Order in person or by mail, or use a case manager’s office phone.'),
  ];
  if (c.foster) links.push(L.ilp);
  if (c.dv) links.push(L.orAcp);
  return {
    id: 'birth_cert',
    title: 'Birth certificate',
    why: 'Usually the first document to get — you need it for a state ID, and many housing and benefit programs ask for it.',
    cost: c.state === 'WA' ? 'Usually about $25 (free in some cases — see below).' : 'About $25–30 from the state.',
    steps,
    tips,
    links,
  };
}

function ssnCard(c) {
  return {
    id: 'ssn_card',
    title: 'Social Security card',
    why: 'Needed for jobs, many housing programs, and benefits like SNAP and OHP.',
    cost: 'Free. Never pay a website for this.',
    steps: [
      'Start online at ssa.gov — some people can request a replacement card entirely online.',
      'Otherwise, visit a Social Security office. Bring proof of identity (usually a state ID) and, if you weren’t born in the U.S., proof of immigration status.',
      'If you don’t have a photo ID yet, ask Social Security which other documents they’ll accept — for young people, school or medical records sometimes work.',
    ],
    tips: [
      ...bullet(c.minor, 'Under 18: a parent or guardian may need to apply with or for you. If that isn’t possible, ask a caseworker or youth shelter to help.'),
      ...bullet(c.foster, 'Foster youth: ask your caseworker for your card — the agency should have it.'),
      ...bullet(c.reentry, 'Reentry: ask your release counselor; many facilities help request a replacement before release.'),
      ...bullet(c.immigrant, 'If you don’t have a Social Security number because of immigration status, talk to an immigration legal service first — many programs (and some jobs, via an ITIN for taxes) have other options.'),
    ],
    links: [L.ssa],
  };
}

function stateId(c) {
  const wa = c.state === 'WA';
  const steps = [
    wa
      ? 'Go to a Washington Department of Licensing office for an ID card ("identicard") or license.'
      : 'Go to an Oregon DMV office for an ID card or driver’s license. You can start the application online first.',
    'Bring: proof of identity and date of birth (birth certificate or passport), your Social Security number, and proof of address. Check the agency’s current list before you go.',
  ];
  if (!wa) steps.push('Oregon issues standard IDs and licenses regardless of immigration status (a REAL ID needs extra proof of lawful status).');
  const tips = [
    ...bullet(c.unhoused && !wa, 'Experiencing homelessness in Oregon? The DMV ID card fee is waived. Get the DMV’s form and have a homeless services provider (shelter, drop-in center, case manager) sign it. The waiver covers ID cards, not driver’s licenses.'),
    ...bullet(c.unhoused && wa, 'Experiencing homelessness? Ask your case manager or 211 about vouchers for the ID fee.'),
    ...bullet(c.lowIncome && !c.unhoused, 'Ask 211 or a case manager about help paying the fee.'),
    ...bullet(c.minor || !c.ageKnown, 'Under 18: a plain ID card is usually easier than a license. A learner’s permit or license generally needs a parent or guardian’s signature.'),
    ...bullet(c.unhoused, 'No home address? See the proof-of-address step — a shelter or service provider letter or mailing address usually works.'),
    ...bullet(c.reentry, 'Reentry: bring your release paperwork; ask your PO or release counselor what the DMV will accept alongside it.'),
    ...bullet(c.dv && !wa, 'Survivors in Oregon’s Address Confidentiality Program can use their substitute address on the ID.'),
  ];
  return {
    id: 'state_id',
    title: wa ? 'Washington state ID or license' : 'Oregon state ID or driver’s license',
    why: 'A photo ID opens almost everything else: apartments, jobs, bank accounts, and many shelters.',
    cost: !wa && c.unhoused ? 'ID card fee waived when a homeless services provider signs the DMV form.' : 'There’s a fee — ask about waivers or vouchers.',
    steps,
    tips,
    links: [wa ? L.waDol : L.orDmv, ...(c.dv && !wa ? [L.orAcp] : [])],
  };
}

function proofAddress(c) {
  return {
    id: 'proof_address',
    title: 'Proof of address or a mailing address',
    why: 'Agencies need somewhere to send your documents and benefits.',
    cost: 'Free.',
    steps: [
      'Ask your shelter, drop-in center, or case manager for a letter confirming where you’re staying (or that you’re experiencing homelessness).',
      'Many service providers let you use their address to receive mail — ask at youth drop-ins like Outside In or New Avenues, or call 211.',
    ],
    tips: [
      ...bullet(c.dv, 'Survivors: Oregon’s Address Confidentiality Program gives you a free substitute address that agencies must accept.'),
      ...bullet(c.minor, 'In school? Your school’s McKinney-Vento (homeless student) liaison can write letters, help with records, and connect you to services.'),
    ],
    links: c.dv ? [L.orAcp] : [],
  };
}

function insurance(c) {
  const wa = c.state === 'WA';
  return {
    id: 'insurance',
    title: wa ? 'Apple Health (Medicaid) card' : 'OHP (Oregon Health Plan) card',
    why: 'Free health, dental, and mental health care — and some programs ask for it.',
    cost: 'Free for people who qualify (most young people with low income).',
    steps: [
      wa ? 'Apply online through Washington Healthplanfinder, or ask a navigator to help.' : 'Apply online at benefits.oregon.gov (the same application covers SNAP), or ask a case manager to help.',
      'If you already have coverage but lost the card, call the number on your plan’s website or your local benefits office for a replacement.',
    ],
    tips: [
      ...bullet(c.foster, 'Former foster youth usually qualify for coverage until 26 regardless of income — say you were in foster care.'),
      ...bullet(c.minor, 'Teens can often apply for their own coverage and get confidential care; ask a school-based health center.'),
    ],
    links: [wa ? L.waHealth : L.ohp],
  };
}

function schoolRecords(c) {
  return {
    id: 'school_records',
    title: 'School records, diploma, or GED transcript',
    why: 'Jobs, training programs, and college ask for proof of school.',
    cost: 'Usually free from schools; small fee for some transcripts.',
    steps: [
      'Contact the last school you attended (or the school district office) and ask for a transcript or a copy of your diploma.',
      'Finished a GED? Order transcripts and the credential from GED.com.',
    ],
    tips: [
      ...bullet(c.unhoused || c.foster, 'Every school district has a McKinney-Vento liaison who can help youth without stable housing get records quickly, without fees.'),
      ...bullet(c.justice, 'Credits earned in OYA or detention schools count — ask the facility’s school for your records.'),
    ],
    links: [L.ged],
  };
}

function immigrationDocs() {
  return {
    id: 'immigration',
    title: 'Immigration documents',
    why: 'Some programs ask for them — but many housing, food, and health programs serve everyone.',
    cost: 'Replacement fees vary; legal help is often free.',
    steps: [
      'Talk to a free or low-cost immigration legal service before applying for benefits or replacing documents (IRCO, Latino Network, or 211 can connect you).',
      'Lost a green card, work permit, or other USCIS document? Replacements are requested through USCIS.',
      'A passport or consular ID from your home country can also serve as photo ID.',
    ],
    tips: ['You never have to share immigration status with this tool or with most shelters and food programs.'],
    links: [L.uscis],
  };
}

function childrenDocs(c) {
  return {
    id: 'children',
    title: 'Your children’s documents',
    why: 'Family shelters and benefits (SNAP, WIC, TANF, childcare help) usually ask for each child’s birth certificate and Social Security number.',
    cost: 'Social Security cards are free; birth certificates have a fee (ask about vouchers).',
    steps: [
      'Order each child’s birth certificate the same way as your own (state vital records). Parents named on the certificate can order it.',
      'If a child doesn’t have a Social Security card, apply at Social Security — it’s free.',
      'Keep copies of shot (immunization) records — schools and childcare ask for them.',
    ],
    tips: c.state === 'WA' ? [] : ['WIC doesn’t require immigration documents, and you can apply while you’re still gathering papers.'],
    links: [c.state === 'WA' ? L.waVital : L.orBirth, L.ssa],
  };
}

const BUILDERS = {
  birth_cert: birthCert,
  ssn_card: ssnCard,
  state_id: stateId,
  proof_address: proofAddress,
  insurance,
  school_records: schoolRecords,
  immigration: immigrationDocs,
};

/** Personal document plan, or null when nothing applies. */
function documentGuide(p) {
  const missing = missingDocuments(p);
  const c = context(p);
  const guides = missing.map((d) => BUILDERS[d](c));
  if (c.hasChildren && missing.length) guides.push(childrenDocs(c));
  if (!guides.length) return null;
  return {
    missing,
    state: c.state,
    note: c.stateKnown
      ? null
      : 'We used Oregon rules because we don’t know your area. In Clark County, Washington, some steps are different.',
    order: 'Usually: birth certificate → Social Security card → state ID. A case manager can help with all of it, and often has fee vouchers.',
    guides,
  };
}

module.exports = { documentGuide, missingDocuments, CORE };
