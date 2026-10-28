'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');
const { extractLinks, nteeNeeds, normalizeName, titleCase, splitCsv } = require('../server/discovery');

const PASSWORD = 'pw';

const IRS_CSV = [
  'EIN,NAME,ICO,STREET,CITY,STATE,ZIP,GROUP,SUBSECTION,AFFILIATION,CLASSIFICATION,RULING,DEDUCTIBILITY,FOUNDATION,ACTIVITY,ORGANIZATION,STATUS,TAX_PERIOD,ASSET_CD,INCOME_CD,FILING_REQ_CD,PF_FILING_REQ_CD,ACCT_PD,ASSET_AMT,INCOME_AMT,REVENUE_AMT,NTEE_CD,SORT_NAME',
  // Youth development org in Gresham — should become a lead
  '111111111,ROCKWOOD YOUTH CONNECTION INC,,100 SE 185TH AVE,GRESHAM,OR,97030-0000,0000,03,3,1000,201001,1,15,000000000,1,01,202312,4,4,01,0,12,500000,600000,600000,O50,',
  // Homeless shelter in Portland that matches an existing program (Outside In)
  '222222222,OUTSIDE IN,,1132 SW 13TH AVE,PORTLAND,OR,97205-0000,0000,03,3,1000,197001,1,15,000000000,1,01,202312,6,6,01,0,06,9000000,12000000,12000000,L41,',
  // Salem — outside the access area
  '333333333,SALEM YOUTH HOUSE,,1 MAIN ST,SALEM,OR,97301-0000,0000,03,3,1000,201001,1,15,000000000,1,01,202312,4,4,01,0,12,500000,600000,600000,O50,',
  // Golf club in Portland — not a relevant activity code
  '444444444,"PORTLAND GOLF CLUB, INC",,1 GREEN WAY,PORTLAND,OR,97201-0000,0000,07,3,1000,195001,2,00,000000000,1,01,202312,6,6,01,0,12,900000,900000,900000,N60,',
  // Tiny food pantry under the revenue floor
  '555555555,TINY PANTRY,,2 ELM ST,PORTLAND,OR,97211-0000,0000,03,3,1000,201901,1,15,000000000,1,01,202312,1,1,02,0,12,1000,5000,5000,K31,',
].join('\n');

const MEMBER_PAGE = `<html><body><nav><a href="/about">About us</a><a href="https://facebook.com/x">Facebook</a></nav>
<h1>Member programs</h1><ul>
<li><a href="https://www.rockwoodyouth.example/programs">Rockwood Youth Connection</a></li>
<li><a href="https://newdv.example">Gateway Survivor Services</a></li>
<li><a href="https://newdv.example/donate">Donate</a></li>
<li><a href="mailto:x@y.org">Email us</a></li>
</ul><script>var t=${Date.now()}</script></body></html>`;

function fakeFetch(state) {
  return async (url, opts = {}) => {
    state.calls.push(url);
    if (url.includes('usaspending')) {
      const body = JSON.parse(opts.body);
      state.usaBodies.push(body);
      const cfda = body.filters.program_numbers[0];
      let results = [];
      if (cfda === '93.550' && !body.subawards)
        results = [{ 'Recipient Name': 'ROCKWOOD YOUTH CONNECTION INC', 'Award Amount': 250000, 'Start Date': '2025-09-30', 'Awarding Agency': 'Department of Health and Human Services', generated_internal_id: 'ASST_NON_X1' }];
      if (cfda === '93.568' && body.subawards)
        results = [{ 'Sub-Awardee Name': 'EAST COUNTY ENERGY HELP', 'Sub-Award Amount': '80000', 'Sub-Award ID': 'S1', 'Prime Recipient Name': 'STATE OF OREGON', 'Sub-Award Date': '2025-01-15' }];
      if (cfda === '14.267' && !body.subawards)
        results = [{ 'Recipient Name': 'MULTNOMAH COUNTY', 'Award Amount': 9000000, generated_internal_id: 'ASST_NON_X2' }];
      return { ok: true, json: async () => ({ results, page_metadata: { page: 1, hasNext: false } }) };
    }
    if (url.includes('eo_or.csv')) return { ok: true, body: new Blob([IRS_CSV]).stream() };
    if (url.includes('eo_wa.csv')) return { ok: true, body: new Blob([IRS_CSV.split('\n')[0]]).stream() };
    if (url.includes('ocadsv')) return { ok: true, text: async () => state.page };
    if (url.includes('multco')) return { ok: false, status: 503 };
    throw new Error(`unexpected ${url}`);
  };
}

async function start() {
  const state = { calls: [], usaBodies: [], page: MEMBER_PAGE };
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 's', discoveryFetch: fakeFetch(state) });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : method === 'GET' ? undefined : '{}',
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await req('POST', '/api/staff/login', { password: PASSWORD });
  return { req, state, app, close: () => server.close() };
}

test('helpers', () => {
  assert.deepEqual(nteeNeeds('L41'), { needs: ['emergency_shelter', 'housing'], youth: false });
  assert.deepEqual(nteeNeeds('O50').youth, true);
  assert.equal(nteeNeeds('N60'), null);
  assert.equal(normalizeName('The Janus Youth Programs, Inc.'), 'janus youth programs');
  assert.equal(titleCase('JANUS YOUTH PROGRAMS INC'), 'Janus Youth Programs Inc');
  assert.deepEqual(splitCsv('1,"A, B","say ""hi"""'), ['1', 'A, B', 'say "hi"']);
  const links = extractLinks(MEMBER_PAGE, 'https://ocadsv.org/members');
  assert.deepEqual(links.map((l) => l.name), ['Rockwood Youth Connection', 'Gateway Survivor Services']);
  assert.equal(links[0].website, 'https://www.rockwoodyouth.example');
});

test('public records become ranked leads for staff review', async (t) => {
  const { req, state, close } = await start();
  t.after(close);

  const run = await req('POST', '/api/staff/discovery/run-all');
  assert.equal(run.status, 200, JSON.stringify(run.data));
  const byId = Object.fromEntries(run.data.map((r) => [r.id, r]));
  assert.match(byId.usaspending.status, /^ok/);
  assert.match(byId['irs-or'].status, /^ok/);
  assert.match(byId['ocadsv-members'].status, /^ok/);
  assert.match(byId['multco-shelter'].status, /^error · HTTP 503/, 'a failing source is recorded, not fatal');

  // USAspending requests use the documented filter shapes.
  const b = state.usaBodies[0];
  assert.deepEqual(b.filters.award_type_codes, ['02', '03', '04', '05']);
  assert.ok(b.filters.recipient_locations.some((l) => l.state === 'OR' && l.county === '051'));
  assert.ok(state.usaBodies.some((x) => x.subawards && x.filters.place_of_performance_locations));

  const { leads, counts } = (await req('GET', '/api/staff/discovery/leads?status=new')).data;
  const names = leads.map((l) => l.name);
  // Found in three independent sources → top of the list.
  assert.equal(names[0], 'Rockwood Youth Connection Inc');
  const top = leads[0];
  assert.deepEqual(new Set(top.evidence.map((e) => e.source)), new Set(['Federal grants', 'IRS nonprofit registry', 'Community network']));
  assert.equal(top.city, 'Gresham');
  assert.equal(top.county, 'multnomah');
  assert.ok(top.needs.includes('housing') && top.needs.includes('mentoring') && top.needs.includes('safety'));
  assert.ok(names.includes('East County Energy Help'), 'subaward recipient');
  assert.ok(names.includes('Gateway Survivor Services'), 'network member');
  assert.ok(!names.some((n) => /salem|golf|tiny/i.test(n)), 'out-of-area, irrelevant, and tiny orgs filtered');
  const all = (await req('GET', '/api/staff/discovery/leads?status=all')).data.leads;
  const county = all.find((l) => l.name === 'Multnomah County');
  assert.ok(county.score < top.score, 'government recipients rank lower');
  assert.equal(county.status, 'known', 'org behind existing programs');

  // Matches existing directory programs instead of suggesting them again.
  const known = (await req('GET', '/api/staff/discovery/leads?status=known')).data.leads;
  const oi = known.find((l) => l.resource_id === 'outside-in');
  assert.ok(oi, 'Outside In linked to existing program');
  assert.ok(counts.known >= 1);
  const records = (await req('GET', '/api/staff/resources/outside-in/records')).data;
  assert.ok(records.some((e) => e.source === 'IRS nonprofit registry'));

  // Re-running doesn't duplicate evidence or inflate scores.
  await req('POST', '/api/staff/discovery/run-all');
  const again = (await req('GET', '/api/staff/discovery/leads?status=new')).data.leads.find((l) => l.id === top.id);
  assert.equal(again.score, top.score);
  assert.equal(again.evidence.length, top.evidence.length);
});

test('staff add or dismiss leads, and add their own pages to watch', async (t) => {
  const { req, state, close } = await start();
  t.after(close);
  await req('POST', '/api/staff/discovery/sources/ocadsv-members/run');
  const { leads } = (await req('GET', '/api/staff/discovery/leads')).data;
  const gw = leads.find((l) => l.name === 'Gateway Survivor Services');
  const rw = leads.find((l) => l.name === 'Rockwood Youth Connection');

  const added = await req('POST', `/api/staff/discovery/leads/${gw.id}/add`, {
    name: gw.name, website: gw.website, categories: ['safety'], counties: ['multnomah'], populations: ['dv'], flags: ['confidential'],
  });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.source, 'discovered');
  const dup = await req('POST', `/api/staff/discovery/leads/${gw.id}/add`, { name: gw.name, categories: ['safety'], counties: ['multnomah'] });
  assert.equal(dup.status, 409);

  assert.equal((await req('POST', `/api/staff/discovery/leads/${rw.id}/dismiss`, { note: 'Not a youth program' })).status, 200);
  const after = (await req('GET', '/api/staff/discovery/leads?status=all')).data.leads;
  assert.equal(after.find((l) => l.id === gw.id).status, 'added');
  assert.equal(after.find((l) => l.id === rw.id).status, 'dismissed');
  await req('POST', `/api/staff/discovery/leads/${rw.id}/restore`);

  // The new program is offered to youth right away.
  const intake = await req('POST', '/api/intake', { consent: true, county: 'multnomah', vulnerabilities: ['dv'] });
  assert.ok(intake.data.byNeed.flatMap((g) => g.matches).some((m) => m.resource.id === added.data.id));

  // Watching a custom county or network page; change detection.
  assert.equal((await req('POST', '/api/staff/discovery/sources', { name: 'x', url: 'ftp://nope' })).status, 400);
  const src = await req('POST', '/api/staff/discovery/sources', { name: 'OCADSV again', url: 'https://www.ocadsv.org/find-help/', needs: ['safety'], network: true });
  assert.equal(src.status, 200, JSON.stringify(src.data));
  await req('POST', `/api/staff/discovery/sources/${src.data.id}/run`);
  state.page = MEMBER_PAGE.replace('</ul>', '<li><a href="https://brandnew.example">Brand New Shelter</a></li></ul>');
  const r2 = await req('POST', `/api/staff/discovery/sources/${src.data.id}/run`);
  assert.match(r2.data.status, /Page changed/);
  assert.equal(r2.data.found, 1);
  assert.equal((await req('DELETE', `/api/staff/discovery/sources/${src.data.id}`)).status, 200);
  assert.equal((await req('DELETE', '/api/staff/discovery/sources/usaspending')).status, 400);
  assert.equal((await req('POST', '/api/staff/discovery/sources/usaspending/enabled', { enabled: false })).status, 200);
  assert.equal((await req('GET', '/api/staff/discovery/sources')).data.find((s) => s.id === 'usaspending').enabled, false);
});

test('program website changes are flagged for re-verification', async (t) => {
  let html = '<p>Open Mon–Fri</p><script>1</script>';
  const linkFetch = async () => ({ ok: true, status: 200, text: async () => html });
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 's', linkFetch });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  const h = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] };
  const check = () => fetch(`${base}/api/staff/resources/check-links`, { method: 'POST', headers: h, body: '{}' }).then((r) => r.json());
  assert.deepEqual((await check()).changed, []);
  html = '<p>Open Mon–Fri</p><script>2</script>'; // script-only change is ignored
  assert.deepEqual((await check()).changed, []);
  html = '<p>Closed until further notice</p>';
  const r = await check();
  assert.ok(r.changed.length > 0);
  const list = await fetch(`${base}/api/staff/resources`, { headers: h }).then((x) => x.json());
  assert.ok(list.every((x) => !x.active || !x.website || x.page_changed_at));
});
