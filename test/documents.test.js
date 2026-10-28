'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { documentGuide, missingDocuments } = require('../server/documents');
const { validateIntake } = require('../server/validate');
const { match, deriveTags, impliedNeeds } = require('../server/matcher');
const { normalizeResource } = require('../server/db');
const { createApp } = require('../server/app');
const seed = require('../data/resources.seed.json');

const resources = seed.map((r) => ({ ...normalizeResource(r), crisis: !!r.crisis, active: true }));
const ids = (g) => g.guides.map((x) => x.id);
const allTips = (g, id) => g.guides.find((x) => x.id === id).tips.join(' ');

test('no guide unless documents are missing or ID help was asked for', () => {
  assert.equal(documentGuide({ age: 19, county: 'multnomah' }), null);
  assert.equal(documentGuide({ age: 19, documents: ['state_id', 'birth_cert', 'ssn_card', 'insurance'] }), null);
  assert.deepEqual(ids(documentGuide({ age: 19, needs: ['id_documents'] })), ['birth_cert', 'ssn_card', 'state_id']);
});

test('only missing documents are covered, in a sensible order', () => {
  const g = documentGuide({ age: 20, county: 'multnomah', documents: ['birth_cert', 'insurance'], needs: ['employment'] });
  assert.deepEqual(ids(g), ['ssn_card', 'state_id', 'school_records']);
  assert.match(g.order, /birth certificate → Social Security card → state ID/);
});

test('guides adapt to area, age, income, and history', () => {
  // Unhoused in Oregon → free DMV ID card via provider attestation, proof-of-address step
  const unhoused = documentGuide({ age: 19, county: 'multnomah', housing: 'street', documents: ['none'] });
  assert.ok(ids(unhoused).includes('proof_address'));
  assert.match(allTips(unhoused, 'state_id'), /fee is waived/);
  assert.equal(unhoused.state, 'OR');

  // Clark County → Washington offices; free WA birth certificate when unhoused
  const wa = documentGuide({ age: 19, county: 'clark', housing: 'couch', documents: ['none'] });
  assert.equal(wa.state, 'WA');
  const waBirth = wa.guides.find((x) => x.id === 'birth_cert');
  assert.ok(waBirth.links.some((l) => l.url.includes('doh.wa.gov')));
  assert.ok(waBirth.steps.join(' ').includes('free'));
  assert.match(wa.guides.find((x) => x.id === 'state_id').title, /Washington/);

  // Minor → parent/guardian and eligibility notes
  const minor = documentGuide({ age: 15, county: 'multnomah', documents: ['none'] });
  assert.match(allTips(minor, 'birth_cert'), /Under 18/);
  assert.match(allTips(minor, 'state_id'), /learner’s permit/);

  // History: foster, reentry, DV, immigrant
  const foster = documentGuide({ age: 18, family: ['aged_out'], documents: ['none'] });
  assert.match(allTips(foster, 'birth_cert'), /Independent Living Program/);
  const reentry = documentGuide({ age: 22, vulnerabilities: ['reentry'], documents: ['none'] });
  assert.match(allTips(reentry, 'birth_cert'), /release counselor or PO/);
  const dv = documentGuide({ age: 22, vulnerabilities: ['dv'], documents: ['none'] });
  assert.match(allTips(dv, 'birth_cert'), /Address Confidentiality Program/);
  const imm = documentGuide({ age: 22, vulnerabilities: ['immigrant'], documents: ['birth_cert'] });
  assert.ok(ids(imm).includes('immigration'));
  assert.match(allTips(imm, 'ssn_card'), /immigration legal service/);

  // Low income → voucher tip; unknown area → note
  const low = documentGuide({ income: 'none', documents: ['none'] });
  assert.match(allTips(low, 'birth_cert'), /voucher/);
  assert.ok(low.note);

  // Children in the household → children's documents
  const kids = documentGuide({ age: 21, household: { for: 'others', members: ['child'] }, documents: ['state_id'] });
  assert.equal(ids(kids).at(-1), 'children');
});

test('every guide link is an official https address', () => {
  const g = documentGuide({ age: 16, county: 'clark', housing: 'street', income: 'none', family: ['aged_out'], vulnerabilities: ['dv', 'immigrant', 'reentry'], needs: ['education'], household: { members: ['child'] }, documents: ['none'] });
  for (const guide of g.guides) for (const l of guide.links) assert.match(l.url, /^https:\/\/[a-z0-9.-]+\.(gov|org|com|us)(\/|$)/, l.url);
});

test('household switch: validation and matching', () => {
  assert.deepEqual(validateIntake({ consent: true, household: { for: 'self', size: 5, members: ['child'] } }).household, { for: 'self', size: 1 });
  const v = validateIntake({ consent: true, household: { for: 'others', size: 4, members: ['child', 'partner'], child_ages: ['1_4'], flags: ['together', 'pets'] } });
  assert.equal(v.household_size, 4);
  assert.deepEqual(v.household.child_ages, ['1_4']);
  assert.throws(() => validateIntake({ consent: true, household: { for: 'others', members: ['dragon'] } }));
  assert.throws(() => validateIntake({ consent: true, household: { size: 99 } }));
  // child ages dropped when no child is listed
  assert.equal(validateIntake({ consent: true, household: { members: ['partner'], child_ages: ['1_4'] } }).household.child_ages, undefined);

  const p = { age: 20, county: 'multnomah', needs: ['emergency_shelter'], household: v.household, preferences: [], vulnerabilities: [] };
  assert.ok(deriveTags(p).includes('parenting'));
  const res = match(p, resources);
  const youthOnly = res.byNeed[0].matches.find((m) => m.resource.flags.includes('youth_only'));
  if (youthOnly) assert.ok(youthOnly.warnings.some((w) => w.includes('all 4 of you')));

  // Someone unsafe in the household → safety programs
  assert.ok(impliedNeeds({ household: { flags: ['unsafe_member'] } }).includes('safety'));
  // Missing ID → ID help is a need
  assert.ok(impliedNeeds({ documents: ['birth_cert'] }).includes('id_documents'));
  assert.ok(!impliedNeeds({ documents: ['birth_cert', 'ssn_card', 'state_id'] }).includes('id_documents'));
  assert.deepEqual(missingDocuments({ documents: ['state_id', 'birth_cert', 'ssn_card'] }), ['insurance']);
});

test('intake returns the household and document plan, and staff see them', async (t) => {
  const app = createApp({ dbFile: ':memory:', staffPassword: 'pw', sessionSecret: 's' });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const r = await req('POST', '/api/intake', {
    consent: true, age: 19, county: 'multnomah', housing: 'car',
    household: { for: 'others', size: 3, members: ['child', 'partner'], child_ages: ['under_1'] },
    documents: ['ssn_card'], needs: ['emergency_shelter'],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.household.size, 3);
  assert.deepEqual(ids(r.data.documents), ['birth_cert', 'state_id', 'proof_address', 'insurance', 'children']);
  assert.ok(r.data.byNeed.some((g) => g.need === 'id_documents'), 'ID help added as a need');

  const refreshed = await req('POST', `/api/followup/${r.data.refCode}/refresh`, {});
  assert.ok(refreshed.data.documents, 'guide comes back on refresh');

  await req('POST', '/api/staff/login', { password: 'pw' });
  const c = (await req('GET', `/api/staff/clients/${r.data.refCode}`)).data.client;
  assert.equal(c.household.size, 3);
  assert.deepEqual(c.documents, ['ssn_card']);
  const dash = (await req('GET', '/api/staff/dashboard')).data.demographics;
  assert.equal(dash.household['3 people'], 1);
  assert.equal(dash.householdMembers.child, 1);
  assert.equal(dash.documentsMissing.birth_cert, 1);

  // Private search doesn't keep household or documents.
  const priv = await req('POST', '/api/intake', { consent: true, confidential: true, household: { for: 'others', size: 2 }, documents: ['none'] });
  const pc = (await req('GET', `/api/staff/clients/${priv.data.refCode}`)).data.client;
  assert.deepEqual(pc.household, {});
  assert.deepEqual(pc.documents, []);
});
