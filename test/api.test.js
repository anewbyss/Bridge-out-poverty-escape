'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');

const PASSWORD = 'test-password';

async function start() {
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 'secret' });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  };
  return { server, req, clearCookie: () => (cookie = '') };
}

const intake = {
  age: 17,
  county: 'multnomah',
  race: ['black'],
  gender: ['nonbinary'],
  lgbtq: 'yes',
  family: ['kicked_out'],
  income: 'none',
  housing: 'couch',
  education: 'not_enrolled_no_diploma',
  employment: 'unemployed_looking',
  vulnerabilities: ['no_id'],
  needs: ['emergency_shelter', 'education', 'utility_assistance'],
  preferences: ['lgbtq_affirming'],
  language: 'en',
  consent: true,
};

test('full flow: intake → follow-up → staff dashboard', async (t) => {
  const { server, req, clearCookie } = await start();
  t.after(() => server.close());

  const tax = await req('GET', '/api/taxonomy');
  assert.equal(tax.status, 200);
  assert.equal(tax.data.AGE_MIN, 9);

  const home = await req('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);

  // Validation
  const tooOld = await req('POST', '/api/intake', { ...intake, age: 30 });
  assert.equal(tooOld.status, 400);
  const noConsent = await req('POST', '/api/intake', { ...intake, consent: false });
  assert.equal(noConsent.status, 400);
  const badNeed = await req('POST', '/api/intake', { ...intake, needs: ['ponies'] });
  assert.equal(badNeed.status, 400);
  const notJson = await req('POST', '/api/intake', null, { 'Content-Type': 'text/plain' });
  assert.equal(notJson.status, 415);

  const r = await req('POST', '/api/intake', intake);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.refCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  // A 17-year-old should not be sent to programs that need an adult account holder.
  const utility = r.data.byNeed.find((g) => g.need === 'utility_assistance').matches.map((m) => m.resource.id);
  assert.ok(!utility.includes('pge-bill-discount'));
  assert.deepEqual(r.data.unmetNeeds, []);
  const shelter = r.data.byNeed.find((g) => g.need === 'emergency_shelter');
  assert.ok(shelter.matches.length > 0);

  // Follow-up with code (case and dash-insensitive)
  const code = r.data.refCode;
  const fu = await req('GET', `/api/followup/${code.toLowerCase().replace('-', '')}`);
  assert.equal(fu.status, 200);
  assert.ok(fu.data.referrals.length > 0);
  assert.equal(fu.data.age, undefined, 'follow-up must not expose demographics');
  const refId = fu.data.referrals[0].id;

  const upd = await req('POST', `/api/followup/${code}/referrals/${refId}`, { status: 'waitlisted', barriers: ['waitlist', 'documents'] });
  assert.equal(upd.status, 200);
  const upd2 = await req('POST', `/api/followup/${code}/referrals/${refId}`, { status: 'received', barriers: ['documents'] });
  assert.equal(upd2.status, 200);
  const badCode = await req('GET', '/api/followup/ZZZZ-ZZZZ');
  assert.equal(badCode.status, 404);

  // A different youth's code can't update this referral
  const other = await req('POST', '/api/intake', { ...intake, age: 22, needs: ['food'] });
  const cross = await req('POST', `/api/followup/${other.data.refCode}/referrals/${refId}`, { status: 'declined', barriers: [] });
  assert.equal(cross.status, 404);

  // Staff endpoints require auth
  assert.equal((await req('GET', '/api/staff/dashboard')).status, 401);
  assert.equal((await req('POST', '/api/staff/login', { password: 'nope' })).status, 401);
  assert.equal((await req('POST', '/api/staff/login', { password: PASSWORD })).status, 200);

  const dash = await req('GET', '/api/staff/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.data.totals.clients, 2);
  assert.equal(dash.data.totals.received, 1);
  assert.equal(dash.data.barriers.documents, 1);
  assert.equal(dash.data.byGroup.lgbtq['LGBTQIA2S+'].received, 1);

  const detail = await req('GET', `/api/staff/clients/${code}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.client.age, 17);
  assert.equal(detail.data.events.length, 2);

  const staffUpd = await req('POST', `/api/staff/referrals/${refId}`, { status: 'received', barriers: [], note: 'Confirmed with provider' });
  assert.equal(staffUpd.status, 200);

  const csv = await req('GET', '/api/staff/export/referrals.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(!csv.data.includes(code), 'export must not include reference codes');

  // Resource management
  const created = await req('POST', '/api/staff/resources', {
    name: 'Test Youth Utility Fund',
    categories: ['utility_assistance'],
    counties: ['multnomah'],
    age_min: 16,
    age_max: 24,
    website: 'https://example.org',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.id, 'test-youth-utility-fund');
  const bad = await req('POST', '/api/staff/resources', { name: 'x', categories: ['nope'], counties: [] });
  assert.equal(bad.status, 400);
  const ver = await req('POST', '/api/staff/resources/test-youth-utility-fund/verify', { verified_by: 'BA' });
  assert.equal(ver.data.verified_by, 'BA');
  assert.ok(ver.data.last_verified);

  // Gaps are logged, and a new resource fills the gap for the next youth
  const gapIntake = { ...intake, county: 'other', needs: ['utility_assistance'] };
  clearCookie();
  const gap = await req('POST', '/api/intake', gapIntake);
  assert.deepEqual(gap.data.unmetNeeds, ['utility_assistance']);
  assert.equal((await req('POST', '/api/staff/login', { password: PASSWORD })).status, 200);
  assert.equal((await req('GET', '/api/staff/dashboard')).data.unmet.utility_assistance, 1);
  await req('POST', '/api/staff/resources', { ...created.data, counties: ['multnomah', 'other'] });
  clearCookie();
  const filled = await req('POST', '/api/intake', gapIntake);
  assert.deepEqual(filled.data.unmetNeeds, []);

  // Deletion
  assert.equal((await req('POST', '/api/staff/login', { password: PASSWORD })).status, 200);
  const del = await req('DELETE', `/api/staff/clients/${code}`, null, { 'Content-Type': 'application/json' });
  assert.equal(del.status, 200);
  assert.equal((await req('GET', `/api/followup/${code}`)).status, 404);
});

test('static files cannot escape the public directory', async (t) => {
  const { server, req } = await start();
  t.after(() => server.close());
  assert.equal((await req('GET', '/../server/app.js')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/server/app.js')).status, 404);
  assert.equal((await req('GET', '/%E0%A4%A')).status, 400);
});
