'use strict';

// "What do I qualify for?" screener.
//
// Plain-language rules for public benefits and programs that young people in
// the Portland area can use, plus every New Avenues for Youth program. Each
// rule looks at a few answers and says "likely", "maybe" or nothing, with the
// reason, where to go, how to apply and what to bring.
//
// IMPORTANT: this is a guide, not a decision. Only the program can decide who
// qualifies. Income limits change every year: maintainers update the federal
// poverty guideline numbers on the staff Settings tab, and anyone editing
// rules here should re-check the program pages listed in `source`.
// Last reviewed: November 2026 (FPL defaults are the 2025 HHS guidelines).
//
// Nothing a person enters in the screener is saved.

const DEFAULT_FPL = { year: 2025, base: 15650, perPerson: 5500 }; // 48 states + DC, yearly

const ANSWER_FLAGS = [
  { id: 'unhoused', label: 'I don’t have a stable place to live (outside, car, shelter, couch-surfing)' },
  { id: 'at_risk', label: 'I’m behind on rent or might get evicted' },
  { id: 'utility_shutoff', label: 'I’m behind on an energy or water bill / got a shut-off notice' },
  { id: 'pays_energy_bill', label: 'The electric or gas bill is in my name' },
  { id: 'pregnant', label: 'I’m pregnant' },
  { id: 'has_children', label: 'I have a child or children' },
  { id: 'kids_under_5', label: 'I have a child under 5' },
  { id: 'in_high_school', label: 'I’m in middle or high school' },
  { id: 'no_diploma', label: 'I left school without a diploma or GED' },
  { id: 'diploma', label: 'I have a high school diploma or GED' },
  { id: 'in_college', label: 'I’m in college or trade school (or want to start)' },
  { id: 'working', label: 'I have a job (any hours)' },
  { id: 'want_job', label: 'I want a job or paid training' },
  { id: 'foster', label: 'I’m in foster care or was in foster care' },
  { id: 'disability', label: 'I have a disability or long-term health condition' },
  { id: 'exploited', label: 'I’ve traded sex, or someone is exploiting me' },
  { id: 'substance_use', label: 'I want help with alcohol or drug use' },
  { id: 'mental_health', label: 'I want counseling or mental health support' },
  { id: 'lgbtq', label: 'I’m LGBTQIA2S+' },
  { id: 'justice', label: 'I have a record, fines, or court issues' },
  { id: 'east_county', label: 'I live or stay in East Portland, Gresham or Rockwood' },
  { id: 'portland_address', label: 'I (or my family) have an address in the City of Portland' },
  { id: 'on_snap', label: 'I already get SNAP (food stamps)' },
  { id: 'on_ohp', label: 'I already have OHP (Oregon Health Plan)' },
  { id: 'on_ssi', label: 'I get SSI' },
];

const GROUPS = [
  { id: 'now', label: 'Help right now' },
  { id: 'nafy', label: 'New Avenues for Youth' },
  { id: 'housing', label: 'Housing & rent' },
  { id: 'food', label: 'Food' },
  { id: 'health', label: 'Health care' },
  { id: 'bills', label: 'Bills, phone & transportation' },
  { id: 'money', label: 'Money & taxes' },
  { id: 'school', label: 'School, college & jobs' },
  { id: 'family', label: 'Pregnant & parenting' },
  { id: 'legal', label: 'Legal help & safety' },
];

const HYC_ACCESS = { name: 'Homeless Youth Continuum Access Center', phone: '503-432-3986', note: 'Call to be screened for New Avenues, Outside In and Janus youth housing and drop-in services.' };
const ONE = { name: 'Oregon ONE (online)', url: 'https://benefits.oregon.gov', phone: '1-800-699-9075', note: 'Apply online, by phone, or at any Oregon Department of Human Services office.' };
const NAFY_MAIN = { name: 'New Avenues for Youth (main office)', address: '1220 SW Columbia St, Portland, OR 97201', phone: '503-224-4339', url: 'https://newavenues.org/contact/' };
const ID_DOCS = ['Photo ID if you have one (you can still apply without it)', 'Proof of income (pay stubs) if you have any'];

// Helper results.
const likely = (...why) => ({ level: 'likely', why });
const maybe = (...why) => ({ level: 'maybe', why });

const PROGRAMS = [
  // ---------------- Help right now ----------------
  {
    id: 'alba-24-7', group: 'now', nafy: true, need: 'emergency_shelter', resource_id: 'nafy-alba',
    name: 'Alba Collaborative: 24/7 safe place for ages 9–17',
    summary: 'Open 24 hours at the Youth Opportunity Center in Rockwood: a bed, meals, showers, hygiene supplies, case management and help with school and jobs. For anyone 9–17 who is in crisis or needs a safe place to stay.',
    how: ['Walk in any time, day or night.', 'Or call 971-754-4350.'],
    where: [{ name: 'New Avenues Youth Opportunity Center', address: '470 SE 165th Ave, Portland, OR 97233', phone: '971-754-4350', url: 'https://newavenues.org/alba/' }],
    bring: ['Nothing is required. Come as you are.'],
    check: (a) => (a.age != null && a.age >= 9 && a.age <= 17 && (a.unhoused || a.exploited) ? likely('You’re 9–17 and need a safe place.') : a.age != null && a.age <= 17 ? maybe('Open 24/7 to anyone 9–17 who needs it.') : null),
  },
  {
    id: 'hyc-access', group: 'now', need: 'housing', resource_id: 'hyc-access-center',
    name: 'Homeless Youth Continuum (Multnomah County)',
    summary: 'The front door to youth housing, shelter, drop-in, legal help and parenting support at New Avenues for Youth, Outside In and Janus Youth Programs. One screening connects you to all of them.',
    how: ['Call the Access Center at 503-432-3986 to complete a screening.', 'You can also ask for a screening in person at a youth drop-in center.'],
    where: [HYC_ACCESS],
    bring: ['Nothing is required for the screening.'],
    check: (a) => (a.age != null && a.age > 24 ? null : a.unhoused ? likely('You don’t have a stable place to live and you’re 24 or younger.') : a.at_risk ? maybe('You may be at risk of losing housing.') : null),
  },

  // ---------------- New Avenues for Youth ----------------
  {
    id: 'nafy-drop-in', group: 'nafy', nafy: true, need: 'basic_needs', resource_id: 'nafy-drop-in',
    name: 'New Avenues Drop-In Day Services',
    summary: 'Meals six days a week, showers, laundry, clothes, computers and internet, activities, and advocates who connect you to school, jobs, housing and LGBTQIA2S+ support. Downtown and in East Multnomah County.',
    how: ['Call the Access Center (503-432-3986) to complete the screening.', 'Downtown staff (Mon–Sat 10 am–6 pm): 971-312-6846.', 'Meals are served in the first hour of each drop-in shift.'],
    where: [
      { name: 'Downtown Drop-In Center', address: '314 SW 9th Ave, Portland, OR 97205', phone: '971-312-6846', hours: 'Mon–Fri 9–10 am, 1–3 pm, 3:30–6 pm; Sat 1–3 pm, 4–6:30 pm', url: 'https://newavenues.org/drop-in-day/' },
      { name: 'East Multnomah Drop-In (Youth Opportunity Center)', address: '470 SE 165th Ave, Portland, OR 97233', hours: 'Mon–Fri 10 am–6 pm', url: 'https://newavenues.org/drop-in-day/' },
    ],
    bring: ['Nothing is required.'],
    check: (a) => (a.age != null && a.age > 24 ? null : a.unhoused ? likely('You don’t have stable housing and you’re 24 or younger.') : a.at_risk ? maybe('Drop-in serves youth who are at risk of homelessness after screening.') : null),
  },
  {
    id: 'nafy-east-connect', group: 'nafy', nafy: true, need: 'basic_needs', resource_id: 'nafy-east-connect',
    name: 'East Connect: outreach for ages 9–24 in East Multnomah County',
    summary: 'Basic needs, harm-reduction supplies, help finding resources, school and job support, case management, and free monthly events.',
    how: ['Drop in Tuesday–Friday, 2–5 pm (visits up to 30 minutes).', 'Call or text 503-753-1506.', 'Staff can also complete Homeless Youth Continuum screenings and intakes.'],
    where: [{ name: 'East Connect drop-in', address: '41 SE 102nd Ave, Portland, OR 97216', phone: '503-753-1506 (call or text)', hours: 'Tue–Fri 2–5 pm', url: 'https://newavenues.org/east-connect/' }],
    bring: ['Nothing is required.'],
    check: (a) => (a.age != null && (a.age < 9 || a.age > 24) ? null : a.east_county ? likely('You’re in East Multnomah County and 9–24.') : null),
  },
  {
    id: 'nafy-housing', group: 'nafy', nafy: true, need: 'housing', resource_id: 'nafy-housing',
    name: 'New Avenues Housing & Shelter',
    summary: 'Transitional housing (The Moxie), Unity House for LGBTQIA2S+ youth, New Doors and New Meadows for youth from foster care, Butterfly House for ages 18–25 in the sex trades, and help with apartments and vouchers. Short-term host homes and shelter for ages 9–17 through Alba.',
    how: ['Get screened through the Access Center: 503-432-3986.', 'Or email New Avenues housing staff with your age, housing situation and whether you have foster care experience; they will follow up about openings.', 'For rent or utility money, call 211.'],
    where: [{ name: 'New Avenues Housing', url: 'https://newavenues.org/housing-and-shelter/' }, HYC_ACCESS],
    bring: ['Nothing is required to be screened.'],
    check: (a) => (a.age != null && a.age > 25 ? null : a.unhoused || (a.foster && a.at_risk) ? likely('You need housing and are in the age range New Avenues serves.') : a.at_risk ? maybe('Housing staff can talk through options.') : null),
  },
  {
    id: 'nafy-new-day', group: 'nafy', nafy: true, need: 'safety', resource_id: 'nafy-new-day',
    name: 'New Day: support for youth 12–25 who trade sex or are being exploited',
    summary: 'No judgment. Mentoring and advocacy, safety planning, transportation, shelter or housing, school and job programs, and LGBTQIA2S+ support.',
    how: ['Call or text 503-258-7081 (Mon–Fri 10 am–6 pm).', 'Any time, day or night: Call to Safety 24/7 line 503-235-5333.'],
    where: [{ name: 'New Day', phone: '503-258-7081 (call or text)', hours: 'Mon–Fri 10 am–6 pm', url: 'https://newavenues.org/new-day/' }, { name: 'Call to Safety (24/7)', phone: '503-235-5333' }],
    bring: ['Nothing is required.'],
    check: (a) => (a.exploited && (a.age == null || (a.age >= 12 && a.age <= 25)) ? likely('You shared that you’ve traded sex or are being exploited, and you’re 12–25.') : null),
  },
  {
    id: 'nafy-rose-thorn', group: 'nafy', nafy: true, need: 'substance_use', resource_id: 'nafy-rose-thorn',
    name: 'ROSE & THORN: drug, alcohol and mental-health support',
    summary: 'Free peer support, recovery resources, treatment connections and one-on-one counseling. THORN serves ages 9–24 and ROSE serves ages 16–24 in Multnomah and Clackamas counties who are unstably housed, have experienced exploitation, or are in or leaving foster care.',
    how: ['Call 503-517-3959 any time to connect.', 'Or fill out the referral form on the program page.'],
    where: [{ name: 'New Avenues behavioral health', address: '314 SW 9th Ave, Portland, OR 97205', phone: '503-517-3959', url: 'https://newavenues.org/rose-addiction-recovery/' }],
    bring: ['Nothing is required.'],
    check: (a) => {
      if (a.age != null && (a.age < 9 || a.age > 24)) return null;
      if (!(a.substance_use || a.mental_health)) return null;
      if (a.county && !['multnomah', 'clackamas'].includes(a.county)) return null;
      return a.unhoused || a.at_risk || a.exploited || a.foster ? likely('You want this support and are in a group the program serves.') : maybe('Eligibility includes housing instability, exploitation or foster care experience.');
    },
  },
  {
    id: 'nafy-education', group: 'nafy', nafy: true, need: 'education', resource_id: 'nafy-education',
    name: 'New Avenues Education: GED and college access',
    summary: 'One-on-one teacher and tutor support to prepare for and take the GED, plus help planning and enrolling in college.',
    how: ['Start with an info session and orientation.', 'Tutoring hours: Tue–Thu 10 am–1 pm and 2–4 pm.'],
    where: [{ name: 'New Avenues Education', address: '314 SW 9th Ave, Portland, OR 97205', hours: 'Tue–Thu 10 am–1 pm, 2–4 pm', url: 'https://newavenues.org/education/' }],
    bring: ['Photo ID for GED testing (staff can help if you don’t have one).'],
    check: (a) => (a.age != null && a.age > 24 ? null : a.no_diploma && (a.unhoused || a.at_risk || a.foster) ? likely('You don’t have a diploma or GED yet.') : a.no_diploma || a.in_college ? maybe('New Avenues may be able to help after screening.') : null),
  },
  {
    id: 'nafy-pave', group: 'nafy', nafy: true, need: 'employment', resource_id: 'nafy-pave',
    name: 'PAVE: job training, paid internships and careers',
    summary: 'A career coach, self-paced job readiness training, a career lab for resumes and applications, and paid work experience at New Avenues INK (screen printing) and the Ben & Jerry’s PartnerShop.',
    how: ['Start with an orientation, which covers eligibility.', 'Call 503-267-4382.'],
    where: [{ name: 'PAVE', address: '314 SW 9th Ave, Portland, OR 97205', phone: '503-267-4382', url: 'https://newavenues.org/job-training-and-employment/' }],
    bring: ['ID and Social Security card or work permit if you have them (needed to be paid). Staff can help you get them.'],
    check: (a) => (a.age != null && a.age > 24 ? null : (a.want_job || a.working) && (a.unhoused || a.at_risk || a.foster) ? likely('You want work and are in a group New Avenues serves.') : a.want_job ? maybe('Eligibility is explained at orientation.') : null),
  },
  {
    id: 'nafy-avenues-to-college', group: 'nafy', nafy: true, need: 'education', resource_id: 'nafy-avenues-to-college',
    name: 'Avenues to College (for youth from foster care)',
    summary: 'College coaching, applications and enrollment support, plus money for housing and living costs, budgeting and scholarship help.',
    how: ['Call the College Recruitment Specialist: 503-206-1666.', 'Ask about workshops and the application.'],
    where: [{ name: 'Avenues to College', phone: '503-206-1666', url: 'https://newavenues.org/services-for-youth-transitioning-from-foster-care/' }],
    bring: ['Proof of foster care placement (staff can help get it).'],
    rules: 'At least 180 days of foster placement after age 14, ages 16–24, and a current or family-of-origin address in the City of Portland.',
    check: (a) => (!a.foster || (a.age != null && (a.age < 16 || a.age > 24)) ? null : a.portland_address ? likely('You have foster care experience and a Portland address.', 'You also need 180+ days in placement after age 14.') : maybe('You need a current or family address in the City of Portland and 180+ days in placement after age 14.')),
  },
  {
    id: 'nafy-legal', group: 'nafy', nafy: true, need: 'legal', resource_id: 'nafy-legal',
    name: 'New Avenues Legal Clinic',
    summary: 'An attorney helps with debt, clearing your record, fine and fee waivers, felony reductions, name and gender marker changes, landlord problems, and custody or family issues.',
    how: ['First get screened into the Homeless Youth Continuum: call 503-432-3986.'],
    where: [{ name: 'New Avenues Legal Services', url: 'https://newavenues.org/legal-services/' }, HYC_ACCESS],
    bring: ['Any court papers, tickets, or letters you have.'],
    check: (a) => (a.age != null && a.age > 24 ? null : (a.justice || a.at_risk) && (a.unhoused || a.at_risk) ? likely('You have a legal issue and may qualify through the Homeless Youth Continuum.') : a.justice || (a.lgbtq && a.unhoused) ? maybe('Available after Homeless Youth Continuum screening.') : null),
  },
  {
    id: 'nafy-family-first', group: 'nafy', nafy: true, need: 'parenting', resource_id: 'nafy-family-first',
    name: 'Family First: pregnant and parenting youth',
    summary: 'A Parent Support Specialist helps with prenatal care, birth planning, parenting groups, and signing up for WIC, SNAP, TANF, childcare (ERDC), Head Start, housing and legal help.',
    how: ['For youth enrolled in the Homeless Youth Continuum.', 'Not enrolled yet? Call the Access Center: 503-432-3986.', 'There may be a waitlist.'],
    where: [{ name: 'Family First', url: 'https://newavenues.org/pregnant-and-parenting-support/' }, HYC_ACCESS],
    bring: ['Nothing is required.'],
    check: (a) => ((a.pregnant || a.has_children) && (a.unhoused || a.at_risk) && (a.age == null || a.age <= 24) ? likely('You’re pregnant or parenting and need housing support.') : null),
  },
  {
    id: 'nafy-smyrc', group: 'nafy', nafy: true, need: 'lgbtq_support', resource_id: 'nafy-smyrc',
    name: 'SMYRC: LGBTQIA2S+ youth center (ages 13–24)',
    summary: 'A safe, harassment-free space for queer and trans youth, plus Unity House, Oregon’s first housing program for LGBTQIA2S+ youth experiencing homelessness.',
    how: ['Visit the downtown location or contact New Avenues.'],
    where: [{ name: 'SMYRC (Joyce N. Furman Building)', address: '1220 SW Columbia St, Portland, OR 97201', url: 'https://newavenues.org/lgbtqia2s-services/' }, NAFY_MAIN],
    bring: ['Nothing.'],
    check: (a) => (a.lgbtq && (a.age == null || (a.age >= 13 && a.age <= 24)) ? likely('You’re LGBTQIA2S+ and 13–24.') : null),
  },

  // ---------------- Housing ----------------
  {
    id: 'rent-assistance-211', group: 'housing', need: 'rent_assistance', resource_id: '211info',
    name: 'Emergency rent and move-in help (through 211info)',
    summary: 'Multnomah, Washington and Clackamas counties fund short-term rent, back-rent and deposit help through local agencies. 211info knows which funds are open today.',
    how: ['Call 211 or text your ZIP code to 898211.', 'Ask for rent assistance for your county. Have your eviction notice or past-due notice ready.'],
    where: [{ name: '211info', phone: '211', url: 'https://www.211info.org' }],
    bring: ['Your lease or rental agreement', 'Any past-due or eviction notice', 'Proof of income for the last 30 days', 'Photo ID'],
    check: (a) => (a.age != null && a.age < 18 ? null : a.at_risk ? likely('You’re behind on rent or facing eviction.') : null),
  },
  {
    id: 'eviction-legal', group: 'housing', need: 'eviction_help', resource_id: 'community-alliance-tenants',
    name: 'Free eviction legal help',
    summary: 'Tenants facing eviction in Oregon can get free legal advice and, in many cases, a lawyer. Don’t ignore court papers. You usually have only days to respond.',
    how: ['Call the Community Alliance of Tenants hotline or Oregon Law Center right away.', 'If you have a court date, go to it.'],
    where: [{ name: 'Community Alliance of Tenants', url: 'https://www.oregoncat.org' }, { name: 'Oregon Law Help', url: 'https://oregonlawhelp.org' }],
    bring: ['All papers from your landlord or the court', 'Your lease'],
    check: (a) => (a.at_risk ? likely('You might be evicted.') : null),
  },
  {
    id: 'fyi-voucher', group: 'housing', need: 'housing', resource_id: 'home-forward',
    name: 'Foster Youth to Independence (FYI) housing voucher',
    summary: 'A federal rent voucher for young people 18–24 who left foster care (or will soon) and are homeless or at risk. It pays part of your rent for up to 3–5 years, with support services.',
    how: ['Ask your ILP worker, caseworker or ODHS Child Welfare for an FYI referral.', 'Home Forward runs the voucher in Multnomah County.'],
    where: [{ name: 'Home Forward', url: 'https://www.homeforward.org' }],
    bring: ['Photo ID', 'Proof of foster care history (your caseworker can help)'],
    check: (a) => (a.foster && a.age != null && a.age >= 18 && a.age <= 24 && (a.unhoused || a.at_risk) ? likely('You’re 18–24 with foster care history and need housing.') : a.foster && (a.age == null || (a.age >= 17 && a.age <= 24)) ? maybe('For ages 18–24 with foster care history who are homeless or at risk.') : null),
  },

  // ---------------- Food ----------------
  {
    id: 'snap', group: 'food', need: 'food', resource_id: 'oregon-snap-ohp',
    name: 'SNAP food benefits (food stamps)',
    summary: 'Money on an EBT card for groceries every month. In Oregon most households with gross income at or below 200% of the federal poverty level qualify.',
    how: ['Apply online with Oregon ONE, by phone, or at an ODHS office.', 'You can get an interview by phone. Emergency SNAP can arrive within 7 days if you have very little money.'],
    where: [ONE],
    bring: ID_DOCS,
    check: (a, c) => {
      if (a.on_snap) return null;
      const notes = [];
      if (a.age != null && a.age < 22 && !a.unhoused && !a.has_children) notes.push('If you’re under 22 and live with a parent, you usually apply as part of their household.');
      if (a.in_college) notes.push('College students need an exemption (for example working 20+ hours a week, caring for a child, or work-study).');
      if (c.pct != null && c.pct > 200) return null;
      if (c.pct == null) return maybe('Depends on your household income.', ...notes);
      return notes.length ? maybe(`Your income looks under the limit (about ${Math.round(c.pct)}% of poverty level).`, ...notes) : likely(`Your income looks under the limit (about ${Math.round(c.pct)}% of poverty level; limit is 200%).`);
    },
  },
  {
    id: 'wic', group: 'food', need: 'parenting', resource_id: 'oregon-wic',
    name: 'WIC (Women, Infants & Children)',
    summary: 'Healthy food, formula, breastfeeding support and nutrition help for pregnant people, new parents, and children under 5. Income limit is 185% of poverty. If you get SNAP or OHP you automatically meet it.',
    how: ['Call your county WIC office or apply online. Appointments can be by phone.'],
    where: [{ name: 'Oregon WIC', url: 'https://www.oregon.gov/oha/ph/healthypeoplefamilies/wic/' }],
    bring: ['ID for you and your child', 'Proof of address', 'Proof of income, or your SNAP/OHP card'],
    check: (a, c) => (!(a.pregnant || a.kids_under_5) ? null : a.on_snap || a.on_ohp ? likely('You’re pregnant or have a child under 5, and SNAP/OHP counts as proof of income.') : c.pct == null ? maybe('You’re pregnant or have a young child. Depends on income (185% of poverty).') : c.pct <= 185 ? likely('You’re pregnant or have a child under 5 and your income is under 185% of poverty.') : null),
  },
  {
    id: 'school-meals', group: 'food', need: 'food', resource_id: null,
    name: 'Free school meals & SUN Bucks (summer food money)',
    summary: 'Many Portland-area schools serve free breakfast and lunch to every student. In summer, SUN Bucks gives $120 per school-age child for groceries to families with low income or on SNAP/OHP.',
    how: ['Ask your school office about free meals.', 'SUN Bucks is automatic for many families on SNAP or OHP; others apply through the Oregon Department of Education.'],
    where: [{ name: 'Oregon SUN Bucks', url: 'https://www.oregon.gov/ode/students-and-family/childnutrition/sfsp/Pages/Summer-EBT.aspx' }],
    bring: ['Nothing for school meals.'],
    check: (a, c) => (!(a.in_high_school || a.has_children) ? null : a.on_snap || a.on_ohp || (c.pct != null && c.pct <= 185) ? likely('You or your child are in school and your household qualifies on income or benefits.') : maybe('Many schools serve free meals to everyone.')),
  },
  {
    id: 'food-pantry', group: 'food', need: 'food', resource_id: 'oregon-food-bank',
    name: 'Free food pantries and meals',
    summary: 'Oregon Food Bank partners run free pantries and meal sites across the area. No income proof is needed at most sites.',
    how: ['Use the Oregon Food Bank “Find Food” map or call 211.'],
    where: [{ name: 'Oregon Food Bank – Find Food', url: 'https://www.oregonfoodbank.org/find-food' }],
    bring: ['Usually nothing. Bring bags if you can.'],
    check: (a, c) => (a.unhoused || a.at_risk || (c.pct != null && c.pct <= 300) ? likely('Free food is open to anyone who needs it.') : null),
  },

  // ---------------- Health ----------------
  {
    id: 'ohp', group: 'health', need: 'health', resource_id: 'oregon-snap-ohp',
    name: 'Oregon Health Plan (OHP / Medicaid)',
    summary: 'Free health, dental, vision, mental health and substance use coverage. Under 19: up to 305% of poverty. Ages 19–64: up to 138%, and OHP Bridge covers 138–200%. Pregnant: up to 190%. Healthier Oregon covers people regardless of immigration status.',
    how: ['Apply with Oregon ONE online, by phone, or with a free OHP-certified community partner.', 'Coverage can start the month you apply.'],
    where: [ONE, { name: 'Find free application help', url: 'https://healthcare.oregon.gov/Pages/find-help.aspx' }],
    bring: ID_DOCS,
    check: (a, c) => {
      if (a.on_ohp) return null;
      if (a.foster && a.age != null && a.age <= 25) return likely('Young people who were in foster care at 18 can keep OHP until 26 regardless of income.');
      const limit = a.pregnant ? 190 : a.age != null && a.age < 19 ? 305 : 200;
      if (c.pct == null) return maybe(`Depends on income (up to ${limit}% of poverty for you).`);
      return c.pct <= limit ? likely(`Your income looks under the ${limit}% limit${limit === 200 ? ' (OHP or OHP Bridge)' : ''}.`) : null;
    },
  },
  {
    id: 'sbhc', group: 'health', need: 'health', resource_id: 'multco-sbhc',
    name: 'School-Based Health Centers (free, confidential)',
    summary: 'Free medical, mental health and reproductive health visits at or near schools for anyone 5–18. Insurance isn’t required. Some services are confidential from parents.',
    how: ['Walk in or call to make an appointment.'],
    where: [{ name: 'Multnomah County SBHCs', url: 'https://www.multco.us/school' }],
    bring: ['Nothing required.'],
    check: (a) => (a.age != null && a.age >= 5 && a.age <= 18 && (a.county == null || a.county === 'multnomah') ? likely('You’re 5–18 in Multnomah County.') : null),
  },

  // ---------------- Bills, phone & transportation ----------------
  {
    id: 'energy-assistance', group: 'bills', need: 'utility_assistance', resource_id: 'multco-energy',
    name: 'Energy bill help (LIHEAP / Oregon Energy Assistance)',
    summary: 'A one-time yearly payment toward your electric or gas bill, plus crisis help if you have a shut-off notice. Income limit is 60% of Oregon’s median income (roughly 200% of poverty for small households).',
    how: ['Multnomah County: apply through the county energy assistance line or online when the program is open (funds open in waves, often fall).', 'Other counties: call 211 for your local agency.'],
    where: [{ name: 'Multnomah County Energy Assistance', url: 'https://www.multco.us/energy-assistance' }, { name: '211info', phone: '211' }],
    bring: ['Your most recent energy bill (and shut-off notice if you have one)', 'Proof of income for the last 30 days', 'ID and Social Security numbers if you have them'],
    check: (a, c) => (!(a.pays_energy_bill || a.utility_shutoff) || (a.age != null && a.age < 18) ? null : c.pct == null ? maybe('Depends on income.') : c.pct <= 200 ? likely('The bill is in your name and your income looks under the limit.') : c.pct <= 250 ? maybe('You may be near the income limit.') : null),
  },
  {
    id: 'pge-discount', group: 'bills', need: 'utility_assistance', resource_id: 'pge-bill-discount',
    name: 'PGE / Pacific Power / NW Natural bill discounts',
    summary: 'Monthly discounts on your bill (up to 60% off at some income levels) for customers with lower income. You can sign up in a few minutes by self-certifying your income.',
    how: ['Call your utility or sign up on its website. Ask about the “income-qualified bill discount”.'],
    where: [{ name: 'PGE Income-Qualified Bill Discount', url: 'https://portlandgeneral.com/save-money/save-money-home/income-qualified-bill-discount' }, { name: 'NW Natural', url: 'https://www.nwnatural.com' }],
    bring: ['Your account number'],
    check: (a, c) => (!a.pays_energy_bill || (a.age != null && a.age < 18) ? null : c.pct == null || c.pct <= 250 ? likely('The bill is in your name and your income may qualify.') : null),
  },
  {
    id: 'water-help', group: 'bills', need: 'utility_assistance', resource_id: 'portland-water-assistance',
    name: 'Portland water/sewer bill discount and crisis help',
    summary: 'Discounts and crisis vouchers for Portland Water Bureau customers with lower income, including some renters who pay water in their rent.',
    how: ['Call the Portland Water Bureau financial assistance line or apply online.'],
    where: [{ name: 'Portland Water Bureau Financial Assistance', url: 'https://www.portland.gov/water/water-bill-discount' }],
    bring: ['Your water bill or lease', 'Proof of income'],
    check: (a, c) => (a.utility_shutoff && (a.county == null || a.county === 'multnomah') && (c.pct == null || c.pct <= 250) ? maybe('If your water bill is part of the problem, you may get a discount or crisis voucher.') : null),
  },
  {
    id: 'lifeline', group: 'bills', need: 'phone_internet', resource_id: 'lifeline-phone',
    name: 'Lifeline phone or internet discount',
    summary: 'About $9.25 a month off phone or internet (Oregon adds more). You qualify with SNAP, OHP/Medicaid, SSI, or income at or below 135% of poverty.',
    how: ['Apply at the National Verifier online or through a Lifeline phone company.'],
    where: [{ name: 'Lifeline National Verifier', url: 'https://www.lifelinesupport.org' }],
    bring: ['ID', 'Your SNAP/OHP/SSI letter or proof of income'],
    check: (a, c) => (a.age != null && a.age < 18 ? null : a.on_snap || a.on_ohp || a.on_ssi ? likely('Getting SNAP, OHP or SSI qualifies you.') : c.pct != null && c.pct <= 135 ? likely('Your income looks under 135% of poverty.') : c.pct == null ? maybe('You qualify with SNAP, OHP, SSI or low income.') : null),
  },
  {
    id: 'trimet', group: 'bills', need: 'transportation', resource_id: 'trimet-reduced-fare',
    name: 'TriMet reduced fares',
    summary: 'Youth fare for ages 7–17 (about half price; many high schoolers get a free student pass). Honored Citizen low-income fare for ages 18–64 at or below 200% of poverty, or if you have OHP or SNAP.',
    how: ['Under 18: just buy a youth fare on Hop. Ask your school about a free student pass.', '18+: apply for an Honored Citizen card online or at a TriMet Ticket Office or partner agency.'],
    where: [{ name: 'TriMet reduced fare', url: 'https://trimet.org/income' }],
    bring: ['ID', 'Proof of income or your OHP/SNAP card (18+)'],
    check: (a, c) => (a.age != null && a.age < 18 ? likely('You can ride on the youth fare.') : a.on_snap || a.on_ohp || (c.pct != null && c.pct <= 200) ? likely('You qualify for the low-income Honored Citizen fare.') : c.pct == null ? maybe('Low-income fare depends on income or OHP/SNAP.') : null),
  },

  // ---------------- Money & taxes ----------------
  {
    id: 'free-taxes-eitc', group: 'money', need: 'employment', resource_id: 'cash-oregon',
    name: 'Free tax filing + tax credits (EITC, Oregon Kids Credit)',
    summary: 'If you worked, filing taxes can get money back even if you owe nothing. EITC is for workers with low income (with kids at any adult age; without kids usually 25+). Oregon Kids Credit adds up to about $1,000 per child under 6.',
    how: ['Get free help from CASH Oregon or IRS VITA sites (January–April), or file free online.'],
    where: [{ name: 'CASH Oregon free tax help', url: 'https://cashoregon.org' }],
    bring: ['W-2s or 1099s', 'ID and Social Security or ITIN numbers for everyone on the return', 'Bank account info for direct deposit'],
    check: (a, c) => (!a.working ? null : a.has_children ? likely('You work and have children, so tax credits could add up.') : a.age != null && a.age >= 25 && (c.pct == null || c.pct <= 150) ? likely('You work and may qualify for the EITC.') : maybe('Filing can return money that was withheld from your paycheck.')),
  },
  {
    id: 'ssi', group: 'money', need: 'health', resource_id: null,
    name: 'SSI (Supplemental Security Income)',
    summary: 'Monthly money for people with a disability that limits work and with very little income and savings. Youth in foster care can apply up to a year before turning 18.',
    how: ['Call Social Security at 1-800-772-1213 or apply at a local office.', 'A legal aid or disability advocate can help. Many first applications are denied, so appeal.'],
    where: [{ name: 'Social Security Administration', phone: '1-800-772-1213', url: 'https://www.ssa.gov/ssi' }],
    bring: ['Medical records and names of doctors', 'ID and birth certificate', 'Bank statements'],
    check: (a, c) => (!a.disability || a.on_ssi ? null : c.pct == null || c.pct <= 100 ? maybe('You have a disability and low income. SSI decides based on medical records.') : null),
  },
  {
    id: 'tanf', group: 'money', need: 'parenting', resource_id: 'oregon-snap-ohp',
    name: 'TANF cash assistance (families with children)',
    summary: 'Monthly cash and job support for parents (and pregnant people) with very low income. Limits are low, about half the poverty level.',
    how: ['Apply with Oregon ONE or at an ODHS office.'],
    where: [ONE],
    bring: ID_DOCS.concat(['Your child’s birth certificate']),
    check: (a, c) => (!(a.has_children || a.pregnant) ? null : c.pct == null || c.pct <= 60 ? (c.pct != null && c.pct <= 40 ? likely('You have children and very low income.') : maybe('Depends on income and household.')) : null),
  },

  // ---------------- School & jobs ----------------
  {
    id: 'oregon-promise', group: 'school', need: 'education', resource_id: 'oregon-promise',
    name: 'Oregon Promise (community college grant)',
    summary: 'Helps pay community college tuition for recent Oregon high school or GED graduates.',
    how: ['Apply through the Oregon Student Aid portal (OSAC) and file the FAFSA or ORSAA.', 'Apply during your senior year or within 6 months of graduating / getting your GED.'],
    where: [{ name: 'Oregon Promise', url: 'https://oregonstudentaid.gov/oregon-promise.aspx' }],
    bring: ['Transcript or GED scores', 'FAFSA or ORSAA'],
    check: (a) => (a.diploma && a.age != null && a.age <= 20 ? maybe('You must apply within 6 months of graduating or getting your GED, and meet GPA/residency rules.') : a.in_high_school && a.age != null && a.age >= 16 ? maybe('Apply during your senior year.') : null),
  },
  {
    id: 'pell-oog', group: 'school', need: 'education', resource_id: null,
    name: 'Pell Grant + Oregon Opportunity Grant',
    summary: 'Free money for college or trade school that you don’t pay back. Youth who were homeless or in foster care can apply as independent students without parent info.',
    how: ['File the FAFSA (or ORSAA if you’re undocumented). Ask the school’s financial aid office about an “unaccompanied homeless youth” or foster determination.'],
    where: [{ name: 'FAFSA', url: 'https://studentaid.gov' }, { name: 'ORSAA', url: 'https://oregonstudentaid.gov/orsaa.aspx' }],
    bring: ['Your tax info (or a letter from a shelter/caseworker if you’re independent)'],
    check: (a, c) => (!(a.in_college || (a.diploma && a.want_job)) ? null : c.pct == null || c.pct <= 300 || a.unhoused || a.foster ? likely('You’re heading to college and your income or situation qualifies for grants.') : maybe('Depends on the FAFSA.')),
  },
  {
    id: 'chafee', group: 'school', need: 'education', resource_id: 'odhs-ilp',
    name: 'Foster youth college money: Chafee ETV + Tuition & Fee Waiver + ILP',
    summary: 'Up to $5,000 a year (Chafee Education & Training Grant) and free tuition at Oregon public colleges (Tuition & Fee Waiver) for current and former foster youth. The Independent Living Program also helps with housing, life skills and money up to age 23.',
    how: ['Apply through OSAC (Oregon Student Aid).', 'Ask your caseworker or ILP provider.'],
    where: [{ name: 'Oregon Student Aid – foster youth', url: 'https://oregonstudentaid.gov' }, { name: 'ODHS Independent Living Program', url: 'https://www.oregon.gov/odhs/children-families/pages/independent-living.aspx' }],
    bring: ['Proof of foster care (caseworker letter)'],
    check: (a) => (a.foster && (a.age == null || (a.age >= 14 && a.age <= 26)) ? (a.in_college || a.diploma ? likely('You have foster care experience and are going to or ready for college.') : maybe('For current/former foster youth. Ask about ILP now and college money later.')) : null),
  },
  {
    id: 'summerworks', group: 'school', need: 'employment', resource_id: 'summerworks',
    name: 'SummerWorks & youth paid internships (ages 16–24)',
    summary: 'Paid summer and year-round internships with Portland-area employers, with a coach and job training.',
    how: ['Apply through a Worksystems youth provider (sign-ups usually open in spring).'],
    where: [{ name: 'Worksystems Youth', url: 'https://www.worksystems.org' }],
    bring: ['ID and Social Security card or work permit'],
    check: (a) => (a.want_job && a.age != null && a.age >= 16 && a.age <= 24 ? likely('You’re 16–24 and want paid work.') : a.want_job && a.age == null ? maybe('For ages 16–24.') : null),
  },
  {
    id: 'job-corps', group: 'school', need: 'employment', resource_id: 'job-corps',
    name: 'Job Corps (free trade training, housing included)',
    summary: 'Free career training, GED/diploma and housing for ages 16–24 with low income.',
    how: ['Apply online or call 1-800-733-5627.'],
    where: [{ name: 'Job Corps', phone: '1-800-733-5627', url: 'https://www.jobcorps.gov' }],
    bring: ['ID', 'Proof of income'],
    check: (a, c) => (a.age != null && a.age >= 16 && a.age <= 24 && (a.want_job || a.no_diploma) && (c.pct == null || c.pct <= 200 || a.unhoused || a.foster) ? maybe('You’re 16–24 and want training. Low income or homelessness qualifies.') : null),
  },

  // ---------------- Pregnant & parenting ----------------
  {
    id: 'erdc', group: 'family', need: 'parenting', resource_id: 'oregon-snap-ohp',
    name: 'Childcare help (ERDC)',
    summary: 'Oregon pays most of your childcare cost while you work or go to school. You can start with income up to 200% of poverty, and copays are low.',
    how: ['Apply through Oregon ONE or call the ERDC line through ODHS.', 'Waitlists can happen, so apply early.'],
    where: [ONE],
    bring: ['Proof of work or school schedule', 'Proof of income', 'Child’s info'],
    check: (a, c) => (!a.has_children || !(a.working || a.in_college || a.in_high_school) ? null : c.pct == null ? maybe('Depends on income.') : c.pct <= 200 ? likely('You have children, work or study, and your income looks under the limit.') : null),
  },
  {
    id: 'head-start', group: 'family', need: 'parenting', resource_id: 'head-start',
    name: 'Head Start, Early Head Start & Preschool for All',
    summary: 'Free early learning for kids under 5. Head Start is for families under the poverty level, homeless families and foster children. Multnomah County Preschool for All offers free preschool for 3- and 4-year-olds, with priority for families with lower income.',
    how: ['Apply through your county Head Start program or the Preschool for All application.'],
    where: [{ name: 'Preschool for All (Multnomah)', url: 'https://www.multco.us/preschool' }, { name: 'Head Start locator', url: 'https://eclkc.ohs.acf.hhs.gov/center-locator' }],
    bring: ['Child’s birth certificate', 'Proof of income or housing situation'],
    check: (a, c) => (!a.kids_under_5 ? null : a.unhoused || (c.pct != null && c.pct <= 100) ? likely('Homeless families and families under the poverty level qualify for Head Start.') : maybe('Preschool for All and Head Start may have spots.')),
  },

  // ---------------- Legal & safety ----------------
  {
    id: 'record-clearing', group: 'legal', need: 'legal', resource_id: 'mpd-expungement',
    name: 'Clearing your record & waiving fines',
    summary: 'Many juvenile and adult records in Oregon can be set aside (expunged), and fines or license suspensions can sometimes be waived. This can open up jobs and housing.',
    how: ['Contact Metropolitan Public Defender’s record clearing project or Oregon Law Help.'],
    where: [{ name: 'Metropolitan Public Defender – Expungement', url: 'https://mpdlaw.com' }, { name: 'Oregon Law Help', url: 'https://oregonlawhelp.org' }],
    bring: ['Any court case numbers or papers'],
    check: (a) => (a.justice ? likely('You mentioned a record or court issue.') : null),
  },
  {
    id: 'call-to-safety', group: 'legal', need: 'safety', resource_id: 'call-to-safety',
    name: 'Call to Safety (24/7 support for abuse, violence and exploitation)',
    summary: 'Confidential 24/7 crisis line, safety planning and connection to shelter.',
    how: ['Call 503-235-5333 any time.'],
    where: [{ name: 'Call to Safety', phone: '503-235-5333', url: 'https://calltosafety.org' }],
    bring: ['Nothing.'],
    check: (a) => (a.exploited ? likely('Free, confidential help any time.') : null),
  },
];

function fplAnnual(fpl, householdSize) {
  const n = Math.max(1, Number(householdSize) || 1);
  return fpl.base + fpl.perPerson * (n - 1);
}

function cleanAnswers(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const age = b.age == null || b.age === '' ? null : Number(b.age);
  out.age = Number.isInteger(age) && age >= 0 && age <= 120 ? age : null;
  const hh = b.household_size == null || b.household_size === '' ? null : Number(b.household_size);
  out.household_size = Number.isInteger(hh) && hh >= 1 && hh <= 20 ? hh : null;
  const inc = b.monthly_income == null || b.monthly_income === '' ? null : Number(String(b.monthly_income).replace(/[$,\s]/g, ''));
  out.monthly_income = Number.isFinite(inc) && inc >= 0 && inc <= 1e6 ? inc : null;
  out.county = typeof b.county === 'string' && /^[a-z_]{2,20}$/.test(b.county) ? b.county : null;
  const flags = new Set(Array.isArray(b.flags) ? b.flags : []);
  for (const f of ANSWER_FLAGS) out[f.id] = flags.has(f.id);
  if (out.kids_under_5) out.has_children = true;
  return out;
}

/**
 * Runs the screener. Returns programs grouped by `GROUPS`, likely first.
 * `fpl` comes from settings so maintainers can update it each year.
 */
function screen(body, { fpl = DEFAULT_FPL } = {}) {
  const a = cleanAnswers(body);
  const annual = a.monthly_income == null ? null : a.monthly_income * 12;
  const pct = annual == null ? null : (annual / fplAnnual(fpl, a.household_size || 1)) * 100;
  const ctx = { pct, fpl };
  const results = [];
  for (const p of PROGRAMS) {
    let r = null;
    try {
      r = p.check(a, ctx);
    } catch {
      r = null;
    }
    if (!r) continue;
    const { check, ...info } = p;
    results.push({ ...info, level: r.level, why: r.why.filter(Boolean) });
  }
  const order = { likely: 0, maybe: 1 };
  return {
    fplYear: fpl.year,
    percentOfPoverty: pct == null ? null : Math.round(pct),
    householdSize: a.household_size || 1,
    groups: GROUPS.map((g) => ({
      ...g,
      programs: results.filter((r) => r.group === g.id).sort((x, y) => order[x.level] - order[y.level]),
    })).filter((g) => g.programs.length),
    total: results.length,
    likely: results.filter((r) => r.level === 'likely').length,
  };
}

// Everything, for the "browse all programs" view and staff reference.
function catalog() {
  return { groups: GROUPS, flags: ANSWER_FLAGS, programs: PROGRAMS.map(({ check, ...p }) => p) };
}

module.exports = { screen, catalog, cleanAnswers, DEFAULT_FPL, ANSWER_FLAGS, PROGRAMS, GROUPS, fplAnnual };
