'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');
const { hsdsProvider, ndpProvider, milesBetween, DEFAULT_CENTER } = require('../server/live');

const PASSWORD = 'pw';

// A fake Open Referral (HSDS v3) directory.
function fakeDirectory() {
  const state = { calls: 0, down: false, slow: false, services: [] };
  const server = http.createServer((req, res) => {
    state.calls++;
    const url = new URL(req.url, 'http://x');
    if (state.down) return res.writeHead(503).end();
    const q = (url.searchParams.get('search') || '').toLowerCase();
    const contents = state.services.filter((s) => s.keywords.some((k) => q.includes(k)));
    const send = () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ total_items: contents.length, contents }));
    if (state.slow) setTimeout(send, 500);
    else send();
  });
  return { server, state };
}

const svc = (id, name, extra) => ({
  id,
  name,
  description: `${name} description`,
  organization: { name: `${name} Org`, website: 'example.org' },
  phones: [{ number: '503-555-0100' }],
  ...extra,
});

async function start(liveOptions = {}) {
  const dir = fakeDirectory();
  dir.state.services = [
    // Gresham, by coordinates (~13 mi)
    svc('a1', 'East County Rent Help', {
      keywords: ['rent'],
      service_at_locations: [{ location: { latitude: 45.4983, longitude: -122.4302, addresses: [{ address_1: '1 Main', city: 'Gresham', state_province: 'OR' }] } }],
    }),
    // Salem, by coordinates (~45 mi) — outside the access area
    svc('a2', 'Salem Rent Fund', {
      keywords: ['rent'],
      service_at_locations: [{ location: { latitude: 44.9429, longitude: -123.0351 } }],
    }),
    // Vancouver, address only
    svc('a3', 'Vancouver Energy Help', { keywords: ['utility', 'energy'], locations: [{ addresses: [{ city: 'Vancouver', state_province: 'WA' }] }] }),
    // No location at all — can't confirm it's local, so it's dropped
    svc('a4', 'Mystery Program', { keywords: ['rent'] }),
  ];
  await new Promise((r) => dir.server.listen(0, r));
  const provider = hsdsProvider({ url: `http://127.0.0.1:${dir.server.address().port}/`, label: 'Test 211' });
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 's', liveProviders: [provider], liveOptions: { timeoutMs: 200, ...liveOptions } });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  const close = () => {
    server.close();
    dir.server.close();
  };
  return { req, dir, app, close };
}

const allIds = (data) => data.byNeed.flatMap((g) => g.matches.map((m) => m.resource.id));

test('distance math', () => {
  const gresham = { lat: 45.4983, lon: -122.4302 };
  const miles = milesBetween(DEFAULT_CENTER, gresham);
  assert.ok(miles > 10 && miles < 15, String(miles));
});

test('live lookup adds nearby listings to matches and the database', async (t) => {
  const { req, dir, close } = await start();
  t.after(close);

  const r = await req('POST', '/api/intake', { consent: true, county: 'multnomah', age: 19, needs: ['rent_assistance', 'utility_assistance'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ids = allIds(r.data);
  assert.ok(ids.includes('live-hsds-a1'), 'Gresham listing matched');
  assert.ok(ids.includes('live-hsds-a3'), 'Vancouver listing matched by city');
  assert.ok(!ids.includes('live-hsds-a2'), 'Salem is outside the access area');
  assert.ok(!ids.includes('live-hsds-a4'), 'listing with no location dropped');

  const card = r.data.byNeed.flatMap((g) => g.matches).find((m) => m.resource.id === 'live-hsds-a1');
  assert.equal(card.resource.live_provider, 'Test 211');
  assert.ok(card.resource.live_miles > 10 && card.resource.live_miles < 15);
  assert.equal(card.resource.website, 'https://example.org');
  assert.ok(card.reasons.some((x) => x.includes('Current listing from Test 211')));
  assert.ok(card.warnings.some((x) => x.includes('call to confirm')));

  // Cached: a second search for the same needs doesn't hit the directory.
  const calls = dir.state.calls;
  await req('POST', '/api/intake', { consent: true, needs: ['rent_assistance'] });
  assert.equal(dir.state.calls, calls);

  // Live listings are offered to youth across the daily-access counties, not Yamhill.
  const clark = await req('POST', '/api/intake', { consent: true, county: 'clark', needs: ['rent_assistance'] });
  assert.ok(allIds(clark.data).includes('live-hsds-a1'));
  const yamhill = await req('POST', '/api/intake', { consent: true, county: 'yamhill', needs: ['rent_assistance'] });
  assert.ok(!allIds(yamhill.data).includes('live-hsds-a1'));

  // They are real directory rows: staff can see, favor, and track them.
  await req('POST', '/api/staff/login', { password: PASSWORD });
  const list = (await req('GET', '/api/staff/resources')).data;
  const row = list.find((x) => x.id === 'live-hsds-a1');
  assert.equal(row.source, 'live:hsds');
  assert.deepEqual(row.counties, ['access_area']);
  const fav = await req('POST', '/api/staff/resources/live-hsds-a1/partner', { partner: true });
  assert.ok(fav.data.flags.includes('partner'));

  const status = (await req('GET', '/api/staff/live')).data;
  assert.equal(status.enabled, true);
  assert.equal(status.providers[0].active, 2);
});

test('falls back to saved listings when the live directory is down or slow', async (t) => {
  const { req, dir, close } = await start({ cacheHours: 0 });
  t.after(close);
  // First search succeeds and saves listings.
  await req('POST', '/api/intake', { consent: true, county: 'multnomah', needs: ['rent_assistance'] });

  dir.state.down = true;
  const r = await req('POST', '/api/intake', { consent: true, county: 'multnomah', needs: ['rent_assistance'] });
  assert.equal(r.status, 200);
  assert.ok(allIds(r.data).includes('live-hsds-a1'), 'saved listing still offered');

  dir.state.down = false;
  dir.state.slow = true;
  const started = Date.now();
  const slow = await req('POST', '/api/intake', { consent: true, county: 'multnomah', needs: ['rent_assistance'] });
  assert.equal(slow.status, 200);
  assert.ok(Date.now() - started < 1500, 'did not wait for the slow directory');

  await req('POST', '/api/staff/login', { password: PASSWORD });
  const status = (await req('GET', '/api/staff/live')).data;
  assert.ok(status.providers[0].errors.some((e) => e.error === 'timed out'));
});

test('staff sync refreshes everything, keeps staff edits, and retires vanished listings', async (t) => {
  const { req, dir, app, close } = await start();
  t.after(close);
  await req('POST', '/api/staff/login', { password: PASSWORD });
  const s1 = await req('POST', '/api/staff/live/sync', {});
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  assert.equal(s1.data.errors.length, 0);
  assert.ok(s1.data.kept >= 2, JSON.stringify(s1.data));

  // Staff verify a1; a3 disappears from the directory and ages out.
  await req('POST', '/api/staff/resources/live-hsds-a1/verify', { verified_by: 'BA' });
  dir.state.services = dir.state.services.filter((s) => s.id !== 'a3');
  app.db.prepare("UPDATE resources SET live_seen_at = datetime('now', '-40 days') WHERE id IN ('live-hsds-a1', 'live-hsds-a3')").run();
  dir.state.services.find((s) => s.id === 'a1').name = 'Renamed Upstream';
  const s2 = await req('POST', '/api/staff/live/sync', {});
  assert.equal(s2.data.retired, 1);
  const list = (await req('GET', '/api/staff/resources')).data;
  assert.equal(list.find((x) => x.id === 'live-hsds-a3').active, false);
  const a1 = list.find((x) => x.id === 'live-hsds-a1');
  assert.equal(a1.active, true);
  assert.equal(a1.name, 'East County Rent Help', 'verified listing is not overwritten');
});

test('sync explains when live lookup is not set up', async (t) => {
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 's' });
  assert.equal(app.live.enabled, false);
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/staff/live/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  assert.equal(r.status, 400);
});

test('211 NDP adapter sends the key and reads common response shapes', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      json: async () => ({
        results: [{ document: { idServiceAtLocation: 'x1', nameService: 'Youth Shelter', nameOrganization: 'Org', latitude: 45.52, longitude: -122.68, address: { city: 'Portland' } } }],
      }),
    };
  };
  const p = ndpProvider({ url: 'https://api.example/search/keyword', apiKey: 'k', fetchImpl });
  const [item] = await p.search({ keyword: 'youth shelter', signal: AbortSignal.timeout(1000) });
  assert.equal(seen.opts.headers['Api-Key'], 'k');
  assert.match(seen.url, /keyword=youth\+shelter/);
  assert.match(seen.url, /location=Portland/);
  assert.equal(item.externalId, 'x1');
  assert.equal(item.name, 'Youth Shelter');
  assert.equal(item.lat, 45.52);
});
