'use strict';

const T = require('./taxonomy');

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
    this.status = 400;
  }
}

const ID_SETS = {
  county: T.ids(T.COUNTIES),
  race: T.ids(T.RACE),
  sex: T.ids(T.SEX),
  gender: T.ids(T.GENDER),
  lgbtq: T.ids(T.LGBTQ),
  family: T.ids(T.FAMILY),
  income: T.ids(T.INCOME),
  income_sources: T.ids(T.INCOME_SOURCES),
  housing: T.ids(T.HOUSING),
  education: T.ids(T.EDUCATION),
  employment: T.ids(T.EMPLOYMENT),
  vulnerabilities: T.ids(T.VULNERABILITIES),
  needs: T.ids(T.NEEDS),
  preferences: T.ids(T.PREFERENCES),
  language: T.ids(T.LANGUAGES),
  status: T.ids(T.OUTCOMES),
  barriers: T.ids(T.BARRIERS),
};

const MULTI = ['race', 'gender', 'family', 'income_sources', 'vulnerabilities', 'needs', 'preferences'];
const SINGLE = ['county', 'sex', 'lgbtq', 'income', 'housing', 'education', 'employment', 'language'];

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

function validateIntake(body) {
  const errors = [];
  const b = body && typeof body === 'object' ? body : {};
  const out = {};

  // Only consent is required. Everything else improves matches but the tool
  // works with whatever we're given.
  const age = b.age == null || b.age === '' ? null : Number(b.age);
  if (age != null && !Number.isInteger(age)) errors.push('Age should be a whole number');
  else if (age != null && (age < T.AGE_MIN || age > T.AGE_MAX)) errors.push(`This tool serves ages ${T.AGE_MIN}–${T.AGE_MAX}`);
  out.age = age;

  for (const key of SINGLE) {
    const v = b[key];
    if (v == null || v === '') out[key] = null;
    else if (!ID_SETS[key].has(v)) errors.push(`Unknown ${key}: ${v}`);
    else out[key] = v;
  }

  for (const key of MULTI) {
    const v = b[key] == null ? [] : b[key];
    if (!Array.isArray(v)) {
      errors.push(`${key} must be a list`);
      continue;
    }
    const bad = v.filter((x) => !ID_SETS[key].has(x));
    if (bad.length) errors.push(`Unknown ${key}: ${bad.join(', ')}`);
    out[key] = [...new Set(v)];
  }

  out.household = validateHousehold(b.household, errors);

  const docs = b.documents == null ? [] : b.documents;
  if (!Array.isArray(docs)) errors.push('documents must be a list');
  else {
    const bad = docs.filter((d) => !DOC_IDS.has(d));
    if (bad.length) errors.push(`Unknown documents: ${bad.join(', ')}`);
  }
  out.documents = Array.isArray(docs) ? [...new Set(docs)] : [];

  out.zip = cleanText(b.zip, 10);
  if (out.zip && !/^\d{5}$/.test(out.zip)) errors.push('ZIP code should be 5 digits');
  const hh = b.household_size == null || b.household_size === '' ? null : Number(b.household_size);
  if (hh != null && (!Number.isInteger(hh) || hh < 1 || hh > 20)) errors.push('Household size should be 1–20');
  out.household_size = hh;
  if (out.household.size && out.household_size == null) out.household_size = out.household.size;
  out.notes = cleanText(b.notes, 2000);

  if (b.consent !== true) errors.push('Please agree to how your information is used');

  // Private search: matches use every answer, but only age, area, language and
  // needs are stored (see store.createIntake).
  out.confidential = b.confidential === true;
  out.contact_ok = b.contact_ok === true && !out.confidential;
  out.contact_method = out.contact_ok ? cleanText(b.contact_method, 20) : null;
  out.contact_value = out.contact_ok ? cleanText(b.contact_value, 200) : null;
  if (out.contact_ok && !['text', 'call', 'email'].includes(out.contact_method)) errors.push('Choose how we can contact you');
  if (out.contact_ok && !out.contact_value) errors.push('Add a phone number or email so we can follow up');

  if (errors.length) throw new ValidationError(errors);
  return out;
}

const DOC_IDS = T.ids(T.DOCUMENTS);
const HH = { for: T.ids(T.HOUSEHOLD_FOR), members: T.ids(T.HOUSEHOLD_MEMBERS), child_ages: T.ids(T.CHILD_AGES), flags: T.ids(T.HOUSEHOLD_FLAGS) };

// { for: 'self'|'others', size, members[], child_ages[], flags[] } — every part optional.
function validateHousehold(h, errors) {
  if (h == null || h === '') return {};
  if (typeof h !== 'object' || Array.isArray(h)) {
    errors.push('household must be an object');
    return {};
  }
  const out = {};
  if (h.for != null && h.for !== '') {
    if (!HH.for.has(h.for)) errors.push(`Unknown household answer: ${h.for}`);
    else out.for = h.for;
  }
  if (out.for === 'self') return { for: 'self', size: 1 };
  if (h.size != null && h.size !== '') {
    const n = Number(h.size);
    if (!Number.isInteger(n) || n < 1 || n > 20) errors.push('Number of people should be 1–20');
    else out.size = n;
  }
  for (const k of ['members', 'child_ages', 'flags']) {
    const v = h[k] == null ? [] : h[k];
    if (!Array.isArray(v)) {
      errors.push(`household ${k} must be a list`);
      continue;
    }
    const bad = v.filter((x) => !HH[k].has(x));
    if (bad.length) errors.push(`Unknown household ${k}: ${bad.join(', ')}`);
    else if (v.length) out[k] = [...new Set(v)];
  }
  if (out.members?.length || out.size > 1) out.for = 'others';
  if (!(out.members || []).includes('child')) delete out.child_ages;
  return out;
}

function validateOutcome(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (!ID_SETS.status.has(b.status)) errors.push('Unknown status');
  const barriers = Array.isArray(b.barriers) ? [...new Set(b.barriers)] : [];
  const bad = barriers.filter((x) => !ID_SETS.barriers.has(x));
  if (bad.length) errors.push(`Unknown barriers: ${bad.join(', ')}`);
  if (errors.length) throw new ValidationError(errors);
  return { status: b.status, barriers, note: cleanText(b.note, 1000) };
}

const RESOURCE_LISTS = {
  categories: ID_SETS.needs,
  populations: T.ids(T.POPULATIONS),
  requires: T.ids(T.POPULATIONS),
  counties: new Set([...ID_SETS.county, 'all', T.ACCESS_AREA.id]),
  languages: ID_SETS.language,
  culturally_specific: ID_SETS.race,
  flags: new Set([...T.ids(T.PREFERENCES), ...T.ids(T.RESOURCE_FLAGS)]),
};

function validateResource(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (!cleanText(b.name, 200)) errors.push('Name is required');
  const id =
    cleanText(b.id, 80) ||
    String(b.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
  if (!/^[a-z0-9-]+$/.test(id || '')) errors.push('ID must be lowercase letters, numbers, and dashes');
  for (const [key, allowed] of Object.entries(RESOURCE_LISTS)) {
    const v = b[key] == null ? [] : b[key];
    if (!Array.isArray(v)) errors.push(`${key} must be a list`);
    else {
      const bad = v.filter((x) => !allowed.has(x));
      if (bad.length) errors.push(`Unknown ${key}: ${bad.join(', ')}`);
    }
  }
  if (!b.categories?.length) errors.push('Pick at least one service category');
  if (!b.counties?.length) errors.push('Pick at least one county (or "all")');
  const min = Number(b.age_min ?? T.AGE_MIN);
  const max = Number(b.age_max ?? T.AGE_MAX);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max || min < 0 || max > 120) errors.push('Invalid age range');
  if (b.website && !/^https?:\/\//i.test(String(b.website))) errors.push('Website must start with http:// or https://');
  if (errors.length) throw new ValidationError(errors);

  const text = (k, n = 500) => cleanText(b[k], n);
  return {
    id,
    name: text('name', 200),
    org: text('org', 200),
    description: text('description', 2000),
    categories: b.categories,
    populations: b.populations || [],
    requires: b.requires || [],
    counties: b.counties,
    languages: b.languages?.length ? b.languages : ['en'],
    culturally_specific: b.culturally_specific || [],
    flags: b.flags || [],
    age_min: min,
    age_max: max,
    phone: text('phone', 60),
    text: text('text', 120),
    website: text('website', 300),
    address: text('address', 300),
    hours: text('hours', 300),
    eligibility: text('eligibility', 1000),
    crisis: !!b.crisis,
    active: b.active !== false,
    last_verified: text('last_verified', 30),
    verified_by: text('verified_by', 100),
  };
}

module.exports = { validateIntake, validateOutcome, validateResource, ValidationError };
