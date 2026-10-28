'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/resources.seed.json');
const { normalizeResource } = require('../server/db');
const { match, deriveTags } = require('../server/matcher');
const T = require('../server/taxonomy');

const resources = seed.map((r) => ({ ...normalizeResource(r), crisis: !!r.crisis, active: true }));
const base = { age: 19, county: 'multnomah', race: [], gender: [], family: [], income_sources: [], vulnerabilities: [], needs: [], preferences: [], language: 'en' };
const ids = (group) => group.matches.map((m) => m.resource.id);
const groupFor = (res, need) => res.byNeed.find((g) => g.need === need);

test('seed resources only use known taxonomy ids', () => {
  const sets = {
    categories: T.ids(T.NEEDS),
    populations: T.ids(T.POPULATIONS),
    requires: T.ids(T.POPULATIONS),
    counties: new Set([...T.ids(T.COUNTIES), 'all']),
    languages: T.ids(T.LANGUAGES),
    culturally_specific: T.ids(T.RACE),
  };
  const seen = new Set();
  for (const r of seed) {
    assert.ok(!seen.has(r.id), `duplicate id ${r.id}`);
    seen.add(r.id);
    assert.ok(r.age_min >= 0 && r.age_min <= r.age_max, `${r.id} age range`);
    assert.match(r.website, /^https:\/\//, `${r.id} website`);
    for (const [k, allowed] of Object.entries(sets))
      for (const v of r[k] || []) assert.ok(allowed.has(v), `${r.id}.${k} has unknown "${v}"`);
  }
});

test('every county has housing, rent, and utility help for an 18-year-old', () => {
  for (const county of ['multnomah', 'washington', 'clackamas', 'clark', 'columbia', 'yamhill']) {
    const res = match({ ...base, age: 18, county, needs: ['emergency_shelter', 'rent_assistance', 'utility_assistance'] }, resources);
    assert.deepEqual(res.unmetNeeds, [], `${county} unmet: ${res.unmetNeeds}`);
  }
});

test('derives population tags from answers', () => {
  const tags = deriveTags({
    ...base,
    age: 15,
    gender: ['two_spirit'],
    race: ['native'],
    family: ['aged_out', 'pregnant'],
    housing: 'couch',
    income: 'none',
    vulnerabilities: ['immigrant'],
  });
  for (const t of ['minor', 'lgbtq', 'trans', 'native', 'foster', 'parenting', 'unhoused', 'low_income', 'immigrant'])
    assert.ok(tags.includes(t), `missing ${t}`);
  assert.ok(!tags.includes('young_adult'));
});

test('respects age limits: utility programs need an adult account holder', () => {
  const res = match({ ...base, age: 14, needs: ['utility_assistance'] }, resources);
  const got = ids(groupFor(res, 'utility_assistance'));
  assert.ok(!got.includes('pge-bill-discount'));
  assert.ok(!got.includes('multco-energy'));
  assert.ok(got.includes('211info'));
});

test('respects county limits', () => {
  const res = match({ ...base, county: 'clark', needs: ['housing'] }, resources);
  const got = ids(groupFor(res, 'housing'));
  assert.ok(got.includes('council-for-homeless'));
  assert.ok(!got.includes('home-forward'));
});

test('population-restricted programs only match eligible youth', () => {
  const noFoster = match({ ...base, needs: ['housing'] }, resources);
  assert.ok(!ids(groupFor(noFoster, 'housing')).includes('bridge-meadows'));
  const foster = match({ ...base, family: ['aged_out'], needs: ['housing'] }, resources);
  assert.ok(ids(groupFor(foster, 'housing')).includes('bridge-meadows'));
});

test('culturally specific programs rank first for matching youth', () => {
  const res = match({ ...base, race: ['native'], needs: ['rent_assistance'] }, resources);
  assert.equal(ids(groupFor(res, 'rent_assistance'))[0], 'naya');
});

test('LGBTQ youth get affirming programs boosted', () => {
  const plain = match({ ...base, needs: ['basic_needs'] }, resources);
  const queer = match({ ...base, lgbtq: 'yes', preferences: ['lgbtq_affirming'], needs: ['basic_needs'] }, resources);
  const score = (res, id) => groupFor(res, 'basic_needs').matches.find((m) => m.resource.id === id).score;
  assert.ok(score(queer, 'outside-in') > score(plain, 'outside-in'));
});

test('crisis answers surface 24/7 lines and add implied needs', () => {
  const res = match({ ...base, age: 13, housing: 'street', vulnerabilities: ['abuse_minor'], needs: ['food'] }, resources);
  assert.ok(res.crisis.length > 0);
  assert.ok(res.crisis.every((r) => r.crisis));
  assert.ok(res.crisis.some((r) => r.id === 'oregon-child-abuse-hotline'));
  assert.deepEqual(res.impliedNeeds.sort(), ['emergency_shelter', 'safety']);
});

test('no crisis section when nothing indicates crisis', () => {
  const res = match({ ...base, housing: 'stable_family', needs: ['education'] }, resources);
  assert.equal(res.crisis.length, 0);
});

test('only a general help line counts as an unmet need', () => {
  const res = match({ ...base, county: 'other', needs: ['eviction_help'] }, resources);
  assert.deepEqual(res.unmetNeeds, ['eviction_help']);
  assert.deepEqual(ids(groupFor(res, 'eviction_help')), ['211info']);
});

test('outcome history moves programs up or down', () => {
  const profile = { ...base, income: 'none', vulnerabilities: ['justice'], needs: ['employment'] };
  const before = match(profile, resources);
  const score = (res, id) => groupFor(res, 'employment').matches.find((m) => m.resource.id === id)?.score;
  const good = match(profile, resources, { 'portland-youthbuilders': { finals: 10, successes: 9, barriers: {} } });
  const bad = match(profile, resources, { 'portland-youthbuilders': { finals: 10, successes: 0, barriers: { waitlist: 6 } } });
  assert.ok(score(good, 'portland-youthbuilders') > score(before, 'portland-youthbuilders'));
  assert.ok(score(bad, 'portland-youthbuilders') < score(before, 'portland-youthbuilders'));
  const warn = groupFor(bad, 'employment').matches.find((m) => m.resource.id === 'portland-youthbuilders').warnings;
  assert.ok(warn.some((w) => w.includes('waitlist')));
});

test('unverified resources carry a call-ahead warning; recent ones do not', () => {
  const now = Date.parse('2026-10-28T00:00:00Z');
  const fresh = resources.map((r) => (r.id === 'outside-in' ? { ...r, last_verified: '2026-10-01' } : r));
  const res = match({ ...base, needs: ['health'] }, fresh, {}, now);
  const g = groupFor(res, 'health');
  const oi = g.matches.find((m) => m.resource.id === 'outside-in');
  assert.ok(!oi.warnings.some((w) => w.includes('verified')));
  assert.ok(g.matches.some((m) => m.warnings.some((w) => w.includes('not yet verified'))));
});
