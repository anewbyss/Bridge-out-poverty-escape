'use strict';

const T = require('./taxonomy');

const MAX_PER_NEED = 5;
const STALE_DAYS = 180;

const TRANS_GENDERS = new Set(['trans_woman', 'trans_man', 'nonbinary', 'two_spirit']);
const UNHOUSED = new Set(['couch', 'shelter', 'car', 'street', 'institution', 'transitional']);
const LOW_INCOME = new Set(['none', 'under_1000', '1000_2000']);
const BENEFITS = new Set(['snap', 'tanf', 'ssi']);
const STUDENT = new Set(['in_school_k8', 'in_high_school', 'ged_progress', 'in_college']);
const RACE_TAGS = new Set(['native', 'black', 'latine', 'asian', 'pacific_islander']);
const CRISIS_VULNS = new Set(T.VULNERABILITIES.filter((v) => v.crisis).map((v) => v.id));

const needLabel = Object.fromEntries(T.NEEDS.map((n) => [n.id, n.label]));
const popLabel = Object.fromEntries(T.POPULATIONS.map((p) => [p.id, p.label]));
const prefLabel = Object.fromEntries(T.PREFERENCES.map((p) => [p.id, p.label]));
const barrierLabel = Object.fromEntries(T.BARRIERS.map((b) => [b.id, b.label]));

// Turns intake answers into population tags that resources can target.
function deriveTags(p) {
  const tags = new Set();
  tags.add(p.age < 18 ? 'minor' : 'young_adult');
  const gender = p.gender || [];
  if (p.lgbtq === 'yes' || p.lgbtq === 'questioning' || gender.some((g) => TRANS_GENDERS.has(g))) tags.add('lgbtq');
  if (gender.some((g) => TRANS_GENDERS.has(g))) tags.add('trans');
  const family = p.family || [];
  if (family.includes('foster_care') || family.includes('aged_out')) tags.add('foster');
  if (family.includes('has_children') || family.includes('pregnant')) tags.add('parenting');
  if (UNHOUSED.has(p.housing)) tags.add('unhoused');
  for (const r of p.race || []) if (RACE_TAGS.has(r)) tags.add(r);
  const v = p.vulnerabilities || [];
  if (v.includes('immigrant')) tags.add('immigrant');
  if (v.includes('dv') || v.includes('abuse_minor')) tags.add('dv');
  if (v.includes('trafficking')) tags.add('trafficking');
  if (v.includes('justice')) tags.add('justice');
  if (v.includes('disability')) tags.add('disability');
  if (LOW_INCOME.has(p.income) || (p.income_sources || []).some((s) => BENEFITS.has(s))) tags.add('low_income');
  if (STUDENT.has(p.education)) tags.add('student');
  return [...tags];
}

// Needs the youth didn't tick but that their answers make urgent.
function impliedNeeds(p) {
  const out = new Set();
  const v = p.vulnerabilities || [];
  if (p.housing === 'street' || p.housing === 'car') out.add('emergency_shelter');
  if (p.housing === 'at_risk') out.add('rent_assistance');
  if (v.includes('dv') || v.includes('trafficking') || v.includes('abuse_minor')) out.add('safety');
  if (v.includes('self_harm') || v.includes('unsafe_now')) out.add('crisis');
  for (const n of p.needs || []) out.delete(n);
  return [...out];
}

function isEligible(resource, p, tags) {
  if (!resource.active) return false;
  if (p.age < resource.age_min || p.age > resource.age_max) return false;
  const counties = resource.counties || [];
  if (!counties.includes('all') && !counties.includes(p.county)) return false;
  const req = resource.requires || [];
  if (req.length && !req.some((t) => tags.includes(t))) return false;
  return true;
}

function daysSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

// Scores one eligible resource for this youth. Returns the score plus plain
// language reasons and warnings so the youth (and staff) can see *why*.
function scoreResource(resource, p, tags, needs, stats, now) {
  const flags = new Set(resource.flags || []);
  const matchedNeeds = needs.filter((n) => resource.categories.includes(n));
  const reasons = [];
  const warnings = [];
  let score = 50 + 8 * (matchedNeeds.length - 1);
  if (matchedNeeds.length > 1) reasons.push(`Helps with ${matchedNeeds.length} of your needs in one place`);

  const focus = (resource.populations || []).filter((t) => tags.includes(t) && t !== 'young_adult');
  for (const t of focus.slice(0, 3)) {
    score += 12;
    reasons.push(`Focuses on ${popLabel[t] || t} youth`);
  }

  const race = p.race || [];
  const cultural = (resource.culturally_specific || []).filter((r) => race.includes(r));
  const prefs = new Set(p.preferences || []);
  if (cultural.length) {
    score += prefs.has('culturally_specific') ? 25 : 15;
    reasons.push('Culturally specific for your community');
  } else if (prefs.has('culturally_specific') && flags.has('culturally_specific')) {
    score += 3;
  }

  if (flags.has('lgbtq_affirming') && tags.includes('lgbtq')) {
    score += prefs.has('lgbtq_affirming') ? 12 : 8;
    reasons.push('LGBTQIA2S+-affirming');
  } else if (prefs.has('lgbtq_affirming') && !flags.has('lgbtq_affirming')) {
    score -= 5;
  }

  for (const pref of prefs) {
    if (pref === 'lgbtq_affirming' || pref === 'culturally_specific') continue;
    if (flags.has(pref)) {
      score += 6;
      reasons.push(prefLabel[pref]);
    }
  }

  if (p.language && p.language !== 'en') {
    if ((resource.languages || []).includes(p.language)) {
      score += 12;
      reasons.push('Offers help in your language');
    } else if (!(resource.languages || []).includes('other')) {
      score -= 8;
      warnings.push('May not offer help in your language — ask for an interpreter');
    }
  }

  if (flags.has('youth_only')) score += 5;
  // Programs built for a narrow age band around this youth usually fit better
  // than "everyone welcome" services.
  const span = resource.age_max - resource.age_min;
  if (span <= 10) score += 4;

  if (needs.includes('emergency_shelter') && resource.crisis) score += 5;

  const age = daysSince(resource.last_verified, now);
  if (age == null) warnings.push('Details not yet verified by staff — call ahead');
  else if (age <= STALE_DAYS) score += 5;
  else {
    score -= 5;
    warnings.push('Details may be out of date — call ahead');
  }

  // Learn from what happened to past referrals.
  const s = stats && stats[resource.id];
  if (s && s.finals >= 3) {
    const rate = (s.successes + 1) / (s.finals + 2);
    score += Math.round((rate - 0.5) * 30);
    reasons.push(`${Math.round(rate * 100)}% of youth referred here got help`);
  }
  if (s && s.barriers) {
    const common = Object.entries(s.barriers)
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    for (const [b] of common) warnings.push(`Others reported: ${(barrierLabel[b] || b).toLowerCase()}`);
    const v = p.vulnerabilities || [];
    if (v.includes('no_id') && s.barriers.documents >= 2) score -= 6;
    if (v.includes('no_phone') && (s.barriers.no_contact >= 2 || s.barriers.phone_internet >= 2)) score -= 6;
    if (tags.includes('minor') && s.barriers.parent_consent >= 2) score -= 6;
  }
  if (tags.includes('minor') && (resource.eligibility || '').toLowerCase().includes('adult')) {
    warnings.push('May need an adult to apply with you');
  }

  return { score, matchedNeeds, reasons, warnings };
}

function summarize(resource) {
  const { id, name, org, description, phone, text, website, address, hours, eligibility, crisis, last_verified, flags } =
    resource;
  return { id, name, org, description, phone, text, website, address, hours, eligibility, crisis, last_verified, flags };
}

/**
 * Matches a validated intake profile to resources.
 * @param {object} profile  validated intake answers
 * @param {object[]} resources  active resources from the directory
 * @param {object} stats  per-resource outcome history { [id]: { finals, successes, barriers } }
 */
function match(profile, resources, stats = {}, now = Date.now()) {
  const tags = deriveTags(profile);
  const implied = impliedNeeds(profile);
  const needs = [...new Set([...implied, ...(profile.needs || [])])];
  const eligible = resources.filter((r) => isEligible(r, profile, tags));

  const scored = new Map();
  for (const r of eligible) {
    if (!r.categories.some((c) => needs.includes(c))) continue;
    scored.set(r.id, { resource: r, ...scoreResource(r, profile, tags, needs, stats, now) });
  }

  const byNeed = [];
  const unmet = [];
  for (const need of needs) {
    const matches = [...scored.values()]
      .filter((m) => m.matchedNeeds.includes(need))
      .sort((a, b) => b.score - a.score || a.resource.name.localeCompare(b.resource.name));
    // 211 can answer almost anything, so it does not count as a real match —
    // it is offered as a fallback and the need is logged as unmet.
    const specific = matches.filter((m) => !(m.resource.flags || []).includes('general'));
    if (!specific.length) unmet.push(need);
    byNeed.push({
      need,
      label: needLabel[need] || need,
      implied: implied.includes(need),
      matches: matches.slice(0, MAX_PER_NEED).map((m) => ({
        resource: summarize(m.resource),
        score: m.score,
        reasons: m.reasons,
        warnings: m.warnings,
        alsoHelpsWith: m.matchedNeeds.filter((n) => n !== need).map((n) => needLabel[n] || n),
      })),
    });
  }

  const crisisNeeded =
    (profile.vulnerabilities || []).some((v) => CRISIS_VULNS.has(v)) ||
    needs.includes('crisis') ||
    profile.housing === 'street';
  const crisis = crisisNeeded
    ? eligible
        .filter((r) => r.crisis)
        .map((r) => ({ r, s: scoreResource(r, profile, tags, needs, stats, now).score }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 6)
        .map(({ r }) => summarize(r))
    : [];

  return { tags, impliedNeeds: implied, needs, crisis, byNeed, unmetNeeds: unmet };
}

module.exports = { match, deriveTags, impliedNeeds, isEligible, STALE_DAYS };
