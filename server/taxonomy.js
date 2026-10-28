'use strict';

// Shared vocabulary for the intake form, the matcher, the resource directory
// and reporting. The client fetches this from /api/taxonomy so the form and the
// server never drift apart.

const AGE_MIN = 9;
const AGE_MAX = 26;

const COUNTIES = [
  { id: 'multnomah', label: 'Multnomah County (Portland, Gresham)' },
  { id: 'washington', label: 'Washington County (Beaverton, Hillsboro, Tigard)' },
  { id: 'clackamas', label: 'Clackamas County (Oregon City, Milwaukie, Happy Valley)' },
  { id: 'clark', label: 'Clark County, WA (Vancouver, Camas)' },
  { id: 'columbia', label: 'Columbia County (St. Helens, Scappoose)' },
  { id: 'yamhill', label: 'Yamhill County (McMinnville, Newberg)' },
  { id: 'other', label: 'Somewhere else / not sure' },
];

const RACE = [
  { id: 'native', label: 'American Indian, Alaska Native, or Indigenous' },
  { id: 'asian', label: 'Asian or Asian American' },
  { id: 'black', label: 'Black, African American, or African' },
  { id: 'latine', label: 'Hispanic, Latina/o/e/x' },
  { id: 'mena', label: 'Middle Eastern or North African' },
  { id: 'pacific_islander', label: 'Native Hawaiian or Pacific Islander' },
  { id: 'white', label: 'White' },
  { id: 'other', label: 'Another identity' },
  { id: 'prefer_not', label: 'Prefer not to say' },
];

const SEX = [
  { id: 'female', label: 'Female' },
  { id: 'male', label: 'Male' },
  { id: 'intersex', label: 'Intersex' },
  { id: 'prefer_not', label: 'Prefer not to say' },
];

const GENDER = [
  { id: 'woman_girl', label: 'Woman / girl' },
  { id: 'man_boy', label: 'Man / boy' },
  { id: 'trans_woman', label: 'Trans woman / trans girl' },
  { id: 'trans_man', label: 'Trans man / trans boy' },
  { id: 'nonbinary', label: 'Nonbinary / genderqueer / gender-fluid' },
  { id: 'two_spirit', label: 'Two-Spirit' },
  { id: 'questioning', label: 'Questioning' },
  { id: 'other', label: 'Another identity' },
  { id: 'prefer_not', label: 'Prefer not to say' },
];

const LGBTQ = [
  { id: 'yes', label: 'Yes, I am LGBTQIA2S+' },
  { id: 'questioning', label: 'Questioning / not sure' },
  { id: 'no', label: 'No' },
  { id: 'prefer_not', label: 'Prefer not to say' },
];

const FAMILY = [
  { id: 'with_parents', label: 'Living with parent(s) or guardian(s)' },
  { id: 'with_relatives', label: 'Living with other relatives or kin' },
  { id: 'foster_care', label: 'In foster care right now' },
  { id: 'aged_out', label: 'Was in foster care / aged out' },
  { id: 'no_family_contact', label: 'No family support or contact' },
  { id: 'kicked_out', label: 'Kicked out or ran away from home' },
  { id: 'has_children', label: 'I have a child or children' },
  { id: 'pregnant', label: 'I am pregnant or expecting' },
  { id: 'partner', label: 'Living with a partner' },
  { id: 'caregiver', label: 'I care for a sibling or family member' },
];

const INCOME = [
  { id: 'none', label: 'No income right now' },
  { id: 'under_1000', label: 'Less than $1,000 / month' },
  { id: '1000_2000', label: '$1,000 – $2,000 / month' },
  { id: '2000_3000', label: '$2,000 – $3,000 / month' },
  { id: 'over_3000', label: 'More than $3,000 / month' },
  { id: 'unknown', label: 'Not sure / prefer not to say' },
];

const INCOME_SOURCES = [
  { id: 'job', label: 'Job (full or part time)' },
  { id: 'gig', label: 'Gig / cash / informal work' },
  { id: 'snap', label: 'SNAP / food benefits' },
  { id: 'tanf', label: 'TANF / cash assistance' },
  { id: 'ssi', label: 'SSI / SSDI' },
  { id: 'family_support', label: 'Help from family or friends' },
  { id: 'foster_stipend', label: 'Foster care / ILP stipend' },
  { id: 'unemployment', label: 'Unemployment benefits' },
];

const HOUSING = [
  { id: 'stable_family', label: 'Stable — with family/guardian', urgency: 0 },
  { id: 'stable_own', label: 'Stable — my own place (renting)', urgency: 0 },
  { id: 'at_risk', label: 'Housed, but at risk of losing it (eviction, can’t pay rent)', urgency: 2 },
  { id: 'couch', label: 'Couch-surfing / staying with friends', urgency: 2 },
  { id: 'shelter', label: 'In a shelter', urgency: 2 },
  { id: 'transitional', label: 'In transitional housing', urgency: 1 },
  { id: 'car', label: 'Sleeping in a car / RV', urgency: 3 },
  { id: 'street', label: 'Sleeping outside / no place tonight', urgency: 3 },
  { id: 'institution', label: 'Leaving jail, detention, hospital, or treatment', urgency: 2 },
];

const EDUCATION = [
  { id: 'in_school_k8', label: 'In elementary / middle school' },
  { id: 'in_high_school', label: 'In high school' },
  { id: 'not_enrolled_no_diploma', label: 'Not in school, no diploma yet' },
  { id: 'ged_progress', label: 'Working on GED / alternative school' },
  { id: 'diploma_ged', label: 'Have diploma or GED' },
  { id: 'in_college', label: 'In college / trade school' },
  { id: 'degree', label: 'Finished college / certificate' },
];

const EMPLOYMENT = [
  { id: 'too_young', label: 'Too young to work / in school' },
  { id: 'unemployed_looking', label: 'Not working, looking for work' },
  { id: 'unemployed_not_looking', label: 'Not working, not looking right now' },
  { id: 'part_time', label: 'Working part time' },
  { id: 'full_time', label: 'Working full time' },
  { id: 'informal', label: 'Informal / gig work' },
  { id: 'unable', label: 'Unable to work (health, disability)' },
];

// "Vulnerability" factors. `crisis: true` means we always surface 24/7 crisis
// lines at the top of the results when the factor is selected.
const VULNERABILITIES = [
  { id: 'unsafe_now', label: 'I don’t feel safe right now', crisis: true },
  { id: 'self_harm', label: 'Thoughts of suicide or hurting myself', crisis: true },
  { id: 'dv', label: 'Violence or abuse at home / in a relationship', crisis: true },
  { id: 'trafficking', label: 'Someone is making me trade sex, work, or favors', crisis: true },
  { id: 'abuse_minor', label: 'An adult is hurting or neglecting me', crisis: true },
  { id: 'disability', label: 'Physical, learning, or developmental disability' },
  { id: 'mental_health', label: 'Mental health challenges' },
  { id: 'substance_use', label: 'Alcohol or drug use concerns' },
  { id: 'chronic_illness', label: 'Chronic illness / medical needs' },
  { id: 'justice', label: 'Involved with juvenile or criminal justice' },
  { id: 'immigrant', label: 'Immigrant, refugee, or undocumented' },
  { id: 'no_id', label: 'Missing ID or documents' },
  { id: 'no_phone', label: 'No reliable phone or internet' },
];

// Needs drive matching. Housing, rental and utility assistance are listed first
// because they are the program's priority areas.
const NEEDS = [
  { id: 'emergency_shelter', label: 'A safe place to sleep tonight', group: 'Housing', priority: true },
  { id: 'housing', label: 'Longer-term or transitional housing', group: 'Housing', priority: true },
  { id: 'rent_assistance', label: 'Help paying rent / deposit / move-in', group: 'Housing', priority: true },
  { id: 'eviction_help', label: 'Help stopping an eviction', group: 'Housing', priority: true },
  { id: 'utility_assistance', label: 'Help paying electric, gas, water, or heat bills', group: 'Housing', priority: true },
  { id: 'food', label: 'Food / meals', group: 'Basic needs' },
  { id: 'basic_needs', label: 'Showers, laundry, clothing, hygiene', group: 'Basic needs' },
  { id: 'phone_internet', label: 'Phone or internet', group: 'Basic needs' },
  { id: 'transportation', label: 'Transportation / bus pass', group: 'Basic needs' },
  { id: 'id_documents', label: 'ID, birth certificate, or documents', group: 'Basic needs' },
  { id: 'health', label: 'Medical care', group: 'Health' },
  { id: 'mental_health', label: 'Counseling / mental health', group: 'Health' },
  { id: 'substance_use', label: 'Drug or alcohol support', group: 'Health' },
  { id: 'education', label: 'School, GED, or college', group: 'Growth' },
  { id: 'employment', label: 'A job or job training', group: 'Growth' },
  { id: 'mentoring', label: 'A mentor or someone to talk to', group: 'Growth' },
  { id: 'legal', label: 'Legal help', group: 'Support' },
  { id: 'lgbtq_support', label: 'LGBTQIA2S+ community & support', group: 'Support' },
  { id: 'parenting', label: 'Parenting or pregnancy support / childcare', group: 'Support' },
  { id: 'safety', label: 'Safety from violence, abuse, or exploitation', group: 'Support' },
  { id: 'crisis', label: 'Someone to talk to right now (crisis)', group: 'Support' },
];

const PREFERENCES = [
  { id: 'youth_only', label: 'Youth-only spaces' },
  { id: 'lgbtq_affirming', label: 'LGBTQIA2S+-affirming' },
  { id: 'culturally_specific', label: 'Run by / for my culture or community' },
  { id: 'walk_in', label: 'Walk-in, no appointment' },
  { id: 'text_chat', label: 'Can reach by text or chat' },
  { id: 'online', label: 'Can apply online' },
  { id: 'no_police', label: 'Doesn’t involve police' },
  { id: 'confidential', label: 'Confidential / no parent notification' },
];

const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish / Español' },
  { id: 'vi', label: 'Vietnamese / Tiếng Việt' },
  { id: 'zh', label: 'Chinese / 中文' },
  { id: 'ru', label: 'Russian / Русский' },
  { id: 'so', label: 'Somali / Soomaali' },
  { id: 'ar', label: 'Arabic / العربية' },
  { id: 'uk', label: 'Ukrainian / Українська' },
  { id: 'asl', label: 'ASL' },
  { id: 'other', label: 'Another language' },
];

// Population tags a resource can focus on or require. Derived for each client
// from their intake answers (see matcher.deriveTags).
const POPULATIONS = [
  { id: 'minor', label: 'Under 18' },
  { id: 'young_adult', label: '18 and older' },
  { id: 'lgbtq', label: 'LGBTQIA2S+' },
  { id: 'trans', label: 'Trans / nonbinary / Two-Spirit' },
  { id: 'foster', label: 'Current or former foster youth' },
  { id: 'parenting', label: 'Pregnant or parenting' },
  { id: 'unhoused', label: 'Unhoused or unstably housed' },
  { id: 'native', label: 'Native / Indigenous' },
  { id: 'black', label: 'Black / African American / African' },
  { id: 'latine', label: 'Latine' },
  { id: 'asian', label: 'Asian / Asian American' },
  { id: 'pacific_islander', label: 'Pacific Islander' },
  { id: 'immigrant', label: 'Immigrant / refugee' },
  { id: 'dv', label: 'Survivors of violence' },
  { id: 'trafficking', label: 'Survivors of exploitation' },
  { id: 'justice', label: 'Justice-involved' },
  { id: 'disability', label: 'People with disabilities' },
  { id: 'low_income', label: 'Low / no income' },
  { id: 'student', label: 'Students' },
];

// Referral lifecycle and the barriers youth and staff can record against it.
const OUTCOMES = [
  { id: 'suggested', label: 'Suggested', final: false },
  { id: 'contacted', label: 'Reached out', final: false },
  { id: 'waitlisted', label: 'On a waitlist', final: false },
  { id: 'received', label: 'Got help', final: true, success: true },
  { id: 'not_eligible', label: 'Not eligible', final: true },
  { id: 'no_response', label: 'No response', final: true },
  { id: 'declined', label: 'Decided not to use it', final: true },
];

const BARRIERS = [
  { id: 'waitlist', label: 'Waitlist or no openings' },
  { id: 'eligibility', label: 'Didn’t meet eligibility rules' },
  { id: 'age', label: 'Too young / too old for the program' },
  { id: 'documents', label: 'Needed ID or documents I don’t have' },
  { id: 'parent_consent', label: 'Needed parent or guardian permission' },
  { id: 'transportation', label: 'Couldn’t get there' },
  { id: 'cost', label: 'Cost too much' },
  { id: 'hours', label: 'Hours didn’t work' },
  { id: 'no_contact', label: 'Couldn’t reach anyone / no call back' },
  { id: 'phone_internet', label: 'No phone or internet to follow up' },
  { id: 'language', label: 'Language barrier' },
  { id: 'discrimination', label: 'Felt unwelcome or discriminated against' },
  { id: 'safety', label: 'Didn’t feel safe there' },
  { id: 'info_wrong', label: 'Info was wrong or outdated' },
  { id: 'paperwork', label: 'Application too hard or long' },
  { id: 'other', label: 'Something else' },
];

const ids = (list) => new Set(list.map((x) => x.id));

module.exports = {
  AGE_MIN,
  AGE_MAX,
  COUNTIES,
  RACE,
  SEX,
  GENDER,
  LGBTQ,
  FAMILY,
  INCOME,
  INCOME_SOURCES,
  HOUSING,
  EDUCATION,
  EMPLOYMENT,
  VULNERABILITIES,
  NEEDS,
  PREFERENCES,
  LANGUAGES,
  POPULATIONS,
  OUTCOMES,
  BARRIERS,
  ids,
};
