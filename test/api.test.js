'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');

const PASSWORD = 'test-password';

async function start(opts = {}) {
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 'secret', ...opts });
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
  return { server, req, app, clearCookie: () => (cookie = ''), login: () => req('POST', '/api/staff/login', { password: PASSWORD }) };
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

test('minimal and private searches, refresh, and validation', async (t) => {
  const { server, req, login } = await start();
  t.after(() => server.close());

  // Only consent is required.
  const min = await req('POST', '/api/intake', { consent: true });
  assert.equal(min.status, 200, JSON.stringify(min.data));
  assert.ok(min.data.usedDefaults);
  assert.ok(min.data.byNeed.length === 3);

  // Private search: matching uses everything, storage keeps only the basics.
  const priv = await req('POST', '/api/intake', {
    consent: true, confidential: true, age: 20, county: 'multnomah', race: ['native'], vulnerabilities: ['dv'],
    needs: ['safety'], notes: 'secret', contact_ok: true, contact_method: 'text', contact_value: '555',
  });
  assert.equal(priv.status, 200);
  assert.ok(priv.data.byNeed[0].matches.some((m) => m.resource.id === 'stronghearts'), 'matching used race + dv');
  await login();
  const detail = (await req('GET', `/api/staff/clients/${priv.data.refCode}`)).data.client;
  assert.equal(detail.confidential, 1);
  assert.deepEqual(detail.race, []);
  assert.deepEqual(detail.vulnerabilities, []);
  assert.equal(detail.notes, null);
  assert.equal(detail.contact_value, null);
  assert.deepEqual(detail.needs, ['safety']);
  assert.equal((await req('GET', '/api/staff/dashboard')).data.totals.confidential, 1);

  // Refresh with new needs; existing referrals are reused, not duplicated.
  const code = min.data.refCode;
  const before = (await req('GET', `/api/followup/${code}`)).data.referrals;
  const refreshed = await req('POST', `/api/followup/${code}/refresh`, { needs: ['rent_assistance', 'food'] });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.equal(refreshed.data.refCode, code);
  assert.deepEqual(refreshed.data.byNeed.map((g) => g.need).sort(), ['food', 'rent_assistance']);
  const after = (await req('GET', `/api/followup/${code}`)).data.referrals;
  const ids = after.map((r) => r.resource_id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate referrals');
  assert.ok(after.length > before.length);
  assert.equal((await req('POST', `/api/followup/${code}/refresh`, { needs: ['nope'] })).status, 400);

  // Validate a connection.
  const ref = after[0];
  assert.equal((await req('POST', `/api/staff/referrals/${ref.id}/validate`, { note: 'x' })).status, 400);
  assert.equal((await req('POST', `/api/staff/referrals/${ref.id}/validate`, { verified_by: 'BA', note: 'Called intake' })).status, 200);
  const v = (await req('GET', `/api/followup/${code}`)).data.referrals.find((r) => r.id === ref.id);
  assert.equal(v.status, 'received');
  assert.equal(v.validated_by, 'BA');
  const dash = (await req('GET', '/api/staff/dashboard')).data;
  assert.equal(dash.totals.validated, 1);
  const stats = (await req('GET', '/api/staff/resources')).data.find((r) => r.id === ref.resource_id).stats;
  assert.equal(stats.validated, 1);
  assert.equal((await req('POST', `/api/staff/referrals/${ref.id}/unvalidate`, {})).status, 200);
  assert.equal((await req('GET', '/api/staff/dashboard')).data.totals.validated, 0);
});

test('refreshing, importing, favoring, and link-checking resources', async (t) => {
  const fakeFetch = async (url) => ({ ok: !url.includes('pearmentor'), status: url.includes('pearmentor') ? 404 : 200 });
  const { server, req, app, login } = await start({ linkFetch: fakeFetch });
  t.after(() => server.close());
  await login();

  // Simulate a database made before some starter programs existed, plus one staff edit.
  app.db.prepare("DELETE FROM resources WHERE id IN ('rainn', 'bradley-angle')").run();
  app.db.prepare("UPDATE resources SET description = 'old text' WHERE id IN ('211info', 'q-center')").run();
  const qc = (await req('GET', '/api/staff/resources')).data.find((r) => r.id === 'q-center');
  assert.equal((await req('POST', '/api/staff/resources', { ...qc, description: 'staff wrote this' })).status, 200);

  const plain = await req('POST', '/api/staff/resources/refresh', {});
  assert.equal(plain.data.added, 2);
  assert.equal(plain.data.updated, 0);
  const full = await req('POST', '/api/staff/resources/refresh', { updateExisting: true });
  assert.ok(full.data.updated > 0);
  const list = (await req('GET', '/api/staff/resources')).data;
  assert.notEqual(list.find((r) => r.id === '211info').description, 'old text');
  assert.equal(list.find((r) => r.id === 'q-center').description, 'staff wrote this', 'staff edits survive refresh');

  // Import
  const imp = await req('POST', '/api/staff/resources/import', {
    resources: [{ name: 'Gresham Youth Rent Fund', categories: ['rent_assistance'], counties: ['multnomah'], website: 'https://example.org' }],
  });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.added, 1);
  const badImp = await req('POST', '/api/staff/resources/import', { resources: [{ name: 'x', categories: [] }] });
  assert.equal(badImp.status, 400);

  // Favor (partner)
  const fav = await req('POST', '/api/staff/resources/oregon-food-bank/partner', { partner: true });
  assert.ok(fav.data.flags.includes('partner'));
  const r = await req('POST', '/api/intake', { consent: true, age: 20, county: 'multnomah', needs: ['food'] });
  const food = r.data.byNeed[0].matches;
  assert.equal(food[0].resource.id, 'oregon-food-bank');
  assert.ok(food[0].resource.flags.includes('partner'));
  const unfav = await req('POST', '/api/staff/resources/oregon-food-bank/partner', { partner: false });
  assert.ok(!unfav.data.flags.includes('partner'));

  // Link check
  const links = await req('POST', '/api/staff/resources/check-links', {});
  assert.equal(links.status, 200);
  assert.deepEqual(links.data.broken.map((b) => b.id), ['pear']);
  const pear = (await req('GET', '/api/staff/resources')).data.find((x) => x.id === 'pear');
  assert.equal(pear.link_status, 'broken (404)');
  const youth = await req('POST', '/api/intake', { consent: true, age: 18, county: 'multnomah', needs: ['mentoring'] });
  const card = youth.data.byNeed[0].matches.find((m) => m.resource.id === 'pear');
  assert.ok(card.warnings.some((w) => w.includes('Website')));
});

test('migrates a database created before age became optional', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, ref_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), source TEXT NOT NULL DEFAULT 'self', age INTEGER NOT NULL,
    county TEXT, zip TEXT, race TEXT NOT NULL DEFAULT '[]', sex TEXT, gender TEXT NOT NULL DEFAULT '[]', lgbtq TEXT,
    family TEXT NOT NULL DEFAULT '[]', household_size INTEGER, income TEXT, income_sources TEXT NOT NULL DEFAULT '[]',
    housing TEXT, education TEXT, employment TEXT, vulnerabilities TEXT NOT NULL DEFAULT '[]', needs TEXT NOT NULL DEFAULT '[]',
    preferences TEXT NOT NULL DEFAULT '[]', language TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT,
    contact_ok INTEGER NOT NULL DEFAULT 0, contact_method TEXT, contact_value TEXT);
    INSERT INTO clients (ref_code, age) VALUES ('AAAA-BBBB', 19);`);
  old.close();
  const { server, req } = await start({ dbFile: file });
  t.after(() => server.close());
  const r = await req('POST', '/api/intake', { consent: true, needs: ['food'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await req('GET', '/api/followup/AAAA-BBBB')).status, 200);
});
