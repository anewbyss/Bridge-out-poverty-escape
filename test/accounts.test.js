'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');
const { hotp } = require('../server/auth');
const { createVault } = require('../server/vault');
const benefits = require('../server/benefits');

const PASSWORD = 'bootstrap-password-1';

async function start(opts = {}) {
  const sent = [];
  const mailer = opts.mailer === undefined ? { send: async (m) => sent.push(m), describe: () => 'fake' } : opts.mailer;
  const app = createApp({ dbFile: ':memory:', staffPassword: PASSWORD, sessionSecret: 'secret', ...opts, mailer });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Each "browser" keeps its own cookie.
  const browser = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, data, headers: res.headers };
    };
  };
  const close = () => {
    server.closeAllConnections();
    server.close();
    app.db.close();
  };
  return { app, browser, sent, close };
}

const totpNow = (secret) => hotp(secret, Math.floor(Date.now() / 30000));

// Sign in as the bootstrap architect and set up two-step sign-in.
async function architect(ctx) {
  const as = ctx.browser();
  assert.equal((await as('POST', '/api/staff/login', { password: PASSWORD })).status, 200);
  const blocked = await as('GET', '/api/staff/users');
  assert.equal(blocked.status, 403, 'architect must set up 2FA before doing anything');
  assert.equal(blocked.data.needs2fa, true);
  const { data } = await as('POST', '/api/staff/account/2fa/begin');
  assert.match(data.otpauth, /^otpauth:\/\/totp\//);
  assert.equal((await as('POST', '/api/staff/account/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await as('POST', '/api/staff/account/2fa/enable', { code: totpNow(data.secret) })).status, 200);
  assert.equal((await as('GET', '/api/staff/users')).status, 200);
  return { as, secret: data.secret };
}

test('accounts: roles, first sign-in, program staff limits, audit log', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const { as, secret } = await architect(ctx);

  // Reusing the same code to sign in again is refused (replay).
  const other = ctx.browser();
  const needCode = await other('POST', '/api/staff/login', { password: PASSWORD });
  assert.equal(needCode.status, 401);
  assert.equal(needCode.data.needCode, true);

  // Create a case worker and a New Avenues program-staff account.
  const bad = await as('POST', '/api/staff/users', { email: 'nope', name: 'X', role: 'case_worker' });
  assert.equal(bad.status, 400);
  const cw = await as('POST', '/api/staff/users', { email: 'Case@Example.org', name: 'Casey', role: 'case_worker' });
  assert.equal(cw.status, 200, JSON.stringify(cw.data));
  assert.equal(cw.data.user.email, 'case@example.org');
  assert.ok(cw.data.tempPassword.length >= 16);
  const partnerNoPrograms = await as('POST', '/api/staff/users', { email: 'p@example.org', name: 'P', role: 'program_partner' });
  assert.equal(partnerNoPrograms.status, 400);
  const pp = await as('POST', '/api/staff/users', { email: 'drop-in@newavenues.example', name: 'Dee', role: 'program_partner', programs: ['nafy-drop-in'] });
  assert.equal(pp.status, 200, JSON.stringify(pp.data));
  assert.equal((await as('POST', '/api/staff/users', { email: 'case@example.org', name: 'Dup', role: 'case_worker' })).status, 409);

  // First sign-in forces a new password.
  const casey = ctx.browser();
  assert.equal((await casey('POST', '/api/staff/login', { email: 'case@example.org', password: 'wrong-password-x' })).status, 401);
  assert.equal((await casey('POST', '/api/staff/login', { email: 'case@example.org', password: cw.data.tempPassword })).status, 200);
  const must = await casey('GET', '/api/staff/clients');
  assert.equal(must.status, 403);
  assert.equal(must.data.mustChangePassword, true);
  assert.equal((await casey('POST', '/api/staff/account/password', { current: cw.data.tempPassword, next: 'short' })).status, 400);
  assert.equal((await casey('POST', '/api/staff/account/password', { current: cw.data.tempPassword, next: 'password-portland-1' })).status, 400, 'common words refused');
  assert.equal((await casey('POST', '/api/staff/account/password', { current: cw.data.tempPassword, next: 'violet tractor ocean lamp 7' })).status, 200);
  assert.equal((await casey('GET', '/api/staff/clients')).status, 200);
  // Case workers can't manage accounts or settings.
  assert.equal((await casey('GET', '/api/staff/users')).status, 403);
  assert.equal((await casey('GET', '/api/staff/settings')).status, 403);
  assert.equal((await casey('GET', '/api/staff/audit')).status, 403);

  // Program staff: only their own program.
  const dee = ctx.browser();
  await dee('POST', '/api/staff/login', { email: 'drop-in@newavenues.example', password: pp.data.tempPassword });
  await dee('POST', '/api/staff/account/password', { current: pp.data.tempPassword, next: 'maple river candle north 42' });
  const mine = await dee('GET', '/api/staff/resources');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.map((r) => r.id), ['nafy-drop-in']);
  assert.equal((await dee('GET', '/api/staff/clients')).status, 403, 'no youth records');
  assert.equal((await dee('GET', '/api/staff/dashboard')).status, 403);
  assert.equal((await dee('GET', '/api/staff/export/referrals.csv')).status, 403);
  const own = mine.data[0];
  const edit = await dee('POST', '/api/staff/resources', { ...own, hours: 'Mon–Sat 9–6', flags: [...own.flags, 'partner'] });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.hours, 'Mon–Sat 9–6');
  assert.ok(!edit.data.flags.includes('partner'), 'program staff cannot make themselves a Partner');
  const outside = (await as('GET', '/api/staff/resources')).data.find((r) => r.id === 'outside-in');
  assert.equal((await dee('POST', '/api/staff/resources', { ...outside, hours: 'hacked' })).status, 403);
  assert.equal((await dee('POST', '/api/staff/resources', { name: 'New thing', categories: ['food'], counties: ['multnomah'] })).status, 403);
  assert.equal((await dee('POST', '/api/staff/resources/outside-in/verify', {})).status, 403);
  assert.equal((await dee('POST', '/api/staff/resources/nafy-drop-in/verify', {})).data.verified_by, 'Dee');

  // Maintainer can't touch architects; architect can't be removed if they're the last one.
  const mt = await as('POST', '/api/staff/users', { email: 'maint@example.org', name: 'Mo', role: 'maintainer' });
  const mo = ctx.browser();
  await mo('POST', '/api/staff/login', { email: 'maint@example.org', password: mt.data.tempPassword });
  await mo('POST', '/api/staff/account/password', { current: mt.data.tempPassword, next: 'granite willow bicycle tea 9' });
  assert.equal((await mo('GET', '/api/staff/users')).data.needs2fa, true, 'maintainers need 2FA too');
  const mb = await mo('POST', '/api/staff/account/2fa/begin');
  await mo('POST', '/api/staff/account/2fa/enable', { code: totpNow(mb.data.secret) });
  const users = (await mo('GET', '/api/staff/users')).data;
  const archId = users.find((u) => u.role === 'architect').id;
  assert.equal((await mo('POST', `/api/staff/users/${archId}`, { active: false })).status, 403);
  assert.equal((await mo('POST', '/api/staff/users', { email: 'a2@example.org', name: 'A2', role: 'architect' })).status, 403);
  assert.equal((await as('POST', `/api/staff/users/${archId}`, { active: false })).status, 400, 'cannot disable yourself');
  // Maintainer can't turn off their own 2FA.
  assert.equal((await mo('POST', '/api/staff/account/2fa/disable', { password: 'granite willow bicycle tea 9' })).status, 400);

  // Disabling an account ends its sessions right away.
  const caseyId = users.find((u) => u.email === 'case@example.org').id;
  assert.equal((await mo('POST', `/api/staff/users/${caseyId}`, { active: false })).status, 200);
  assert.equal((await casey('GET', '/api/staff/clients')).status, 401);

  // Reset password issues a new temporary one and signs them out.
  const reset = await as('POST', `/api/staff/users/${users.find((u) => u.email === 'drop-in@newavenues.example').id}/reset-password`);
  assert.ok(reset.data.tempPassword);
  assert.equal((await dee('GET', '/api/staff/resources')).status, 401);

  const log = (await as('GET', '/api/staff/audit')).data.map((e) => e.action);
  for (const a of ['login', 'login.failed', 'user.create', 'user.update', 'resource.update', 'account.password_changed', 'user.reset_password'])
    assert.ok(log.includes(a), `audit has ${a}`);
  assert.ok(secret);
});

test('sign-in lockouts and stolen-session protections', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false });
  t.after(ctx.close);
  const a = ctx.browser();
  for (let i = 0; i < 4; i++) assert.equal((await a('POST', '/api/staff/login', { password: `wrong-${i}` })).status, 401);
  assert.equal((await a('POST', '/api/staff/login', { password: 'wrong-5' })).status, 429);
  assert.equal((await a('POST', '/api/staff/login', { password: PASSWORD })).status, 429, 'locked even with the right password');

  // Cookies are tamper-proof and signed.
  const fresh = await start({ enforceAdmin2fa: false });
  t.after(fresh.close);
  const b = fresh.browser();
  const ok = await b('POST', '/api/staff/login', { password: PASSWORD });
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  // Changing the user id inside the cookie breaks its signature.
  const forged = cookie.split(';')[0].replace(/^(bop_staff=)(\d+)/, '$12');
  const anon = fresh.browser();
  assert.equal((await anon('GET', '/api/staff/dashboard', null, { Cookie: forged })).status, 401);
  assert.equal((await b('GET', '/api/staff/dashboard')).status, 200);

  // Cross-site writes are blocked even with a valid cookie.
  const cross = await b('POST', '/api/staff/resources/refresh', {}, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  // Logout everywhere ends the session.
  assert.equal((await b('POST', '/api/staff/account/logout-all')).status, 200);
  assert.equal((await b('GET', '/api/staff/dashboard')).status, 401);

  // Secure deployments use the __Host- cookie and send HSTS.
  const secure = await start({ enforceAdmin2fa: false, secureCookies: true });
  t.after(secure.close);
  const s = secure.browser();
  const sres = await s('POST', '/api/staff/login', { password: PASSWORD });
  assert.match(sres.headers.get('set-cookie'), /^__Host-bop_staff=.*Secure/);
  assert.match(sres.headers.get('strict-transport-security'), /max-age=/);
});

test('staff IP allowlist hides the staff API from other addresses', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false, staffAllowedIps: ['10.9.9.9'] });
  t.after(ctx.close);
  const a = ctx.browser();
  assert.equal((await a('POST', '/api/staff/login', { password: PASSWORD })).status, 404);
  assert.equal((await a('GET', '/api/resources')).status, 200, 'public pages still work');
  const allowed = await start({ enforceAdmin2fa: false, staffAllowedIps: ['127.0.0.1', '::1'] });
  t.after(allowed.close);
  assert.equal((await allowed.browser()('POST', '/api/staff/login', { password: PASSWORD })).status, 200);
});

test('check-in codes cannot be brute-forced, and youth can delete their own record', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false });
  t.after(ctx.close);
  const y = ctx.browser();
  const r = await y('POST', '/api/intake', { consent: true, age: 19, needs: ['food'] });
  const code = r.data.refCode;
  const guesser = ctx.browser();
  let last;
  for (let i = 0; i < 21; i++) last = await guesser('GET', `/api/followup/ZZZZ-ZZ${String(i).padStart(2, '2').replace(/[01]/g, '3')}`);
  assert.equal(last.status, 429);
  assert.equal((await guesser('GET', `/api/followup/${code}`)).status, 429, 'blocked even for a real code after guessing');
  ctx.app.db.prepare('DELETE FROM audit_log').run();

  const fresh = await start({ enforceAdmin2fa: false });
  t.after(fresh.close);
  const f = fresh.browser();
  const mine = await f('POST', '/api/intake', { consent: true, age: 19, needs: ['food'] });
  assert.equal((await f('DELETE', `/api/followup/${mine.data.refCode}`)).status, 200);
  assert.equal((await f('GET', `/api/followup/${mine.data.refCode}`)).status, 404);

  // Under 13s can't leave contact details on their own.
  const kid = await f('POST', '/api/intake', { consent: true, age: 11, contact_ok: true, contact_method: 'text', contact_value: '5035551212' });
  assert.equal(kid.status, 400);
});

test('refer me: saved, encrypted at rest, emailed without contact details by default', async (t) => {
  const key = crypto.randomBytes(32).toString('hex');
  const ctx = await start({ enforceAdmin2fa: false, vault: createVault(key), publicUrl: 'https://bridge.example' });
  t.after(ctx.close);
  const y = ctx.browser();
  const body = {
    consent: true, resource_id: 'nafy-drop-in', need: 'basic_needs', first_name: 'Sam', age: 17, county: 'multnomah',
    contact_method: 'text', contact_value: '503-555-0142', safe_to_message: false, note: 'Please text after 3',
  };
  assert.equal((await y('POST', '/api/refer', { ...body, consent: false })).status, 400);
  assert.equal((await y('POST', '/api/refer', { ...body, contact_value: '12' })).status, 400);
  assert.equal((await y('POST', '/api/refer', { ...body, resource_id: 'not-real' })).status, 400);
  assert.equal((await y('POST', '/api/refer', { ...body, age: 11 })).status, 400, 'under 13 needs an adult helper');
  const ok = await y('POST', '/api/refer', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.emailed, true);
  // Honeypot: bots get a fake OK, nothing is saved or sent.
  assert.equal((await y('POST', '/api/refer', { ...body, website: 'http://spam' })).data.id, null);

  assert.equal(ctx.sent.length, 1);
  const mail = ctx.sent[0];
  assert.equal(mail.to, 'ripchoom@gmail.com');
  assert.match(mail.subject, /New Avenues Drop-In/);
  assert.ok(!mail.text.includes('503-555-0142'), 'no phone number in the email');
  assert.ok(!mail.text.includes('Sam'), 'no name in the email');
  assert.match(mail.text, /https:\/\/bridge\.example\/staff#requests/);

  // Stored encrypted.
  const raw = ctx.app.db.prepare('SELECT contact_value, first_name, note FROM referral_requests').get();
  assert.match(raw.contact_value, /^enc1:/);
  assert.match(raw.first_name, /^enc1:/);
  assert.ok(!JSON.stringify(raw).includes('555'));

  // Staff see it decrypted; program staff only see their program's requests.
  const as = ctx.browser();
  await as('POST', '/api/staff/login', { password: PASSWORD });
  const list = await as('GET', '/api/staff/requests');
  assert.equal(list.data.requests[0].contact_value, '503-555-0142');
  assert.equal(list.data.requests[0].program, 'New Avenues Drop-In Day Services');
  assert.equal((await as('GET', '/api/staff/me')).data.openRequests, 1);
  const p1 = await as('POST', '/api/staff/users', { email: 'east@example.org', name: 'E', role: 'program_partner', programs: ['nafy-east-connect'] });
  const e = ctx.browser();
  await e('POST', '/api/staff/login', { email: 'east@example.org', password: p1.data.tempPassword });
  await e('POST', '/api/staff/account/password', { current: p1.data.tempPassword, next: 'harbor quilt meadow spoon 3' });
  assert.equal((await e('GET', '/api/staff/requests')).data.requests.length, 0);
  const id = list.data.requests[0].id;
  assert.equal((await e('POST', `/api/staff/requests/${id}`, { status: 'closed' })).status, 404);
  const upd = await as('POST', `/api/staff/requests/${id}`, { status: 'contacted', staff_note: 'Texted Sam' });
  assert.equal(upd.data.status, 'contacted');
  assert.equal(upd.data.handled_by, 'Main architect');
  assert.match(ctx.app.db.prepare('SELECT staff_note FROM referral_requests').get().staff_note, /^enc1:/);

  // This address has used its 5 requests for the hour (failed tries count too).
  assert.equal((await y('POST', '/api/refer', body)).status, 429);

  // Full-detail emails are an explicit choice.
  assert.equal((await as('POST', '/api/staff/settings', { email_details: 'full', referral_email: 'staff@example.org' })).status, 200);
  const ctx2 = await start({ enforceAdmin2fa: false, emailDetails: 'full', referralEmail: 'staff@example.org' });
  t.after(ctx2.close);
  await ctx2.browser()('POST', '/api/refer', { ...body, first_name: 'Robin' });
  assert.equal(ctx2.sent[0].to, 'staff@example.org');
  assert.match(ctx2.sent[0].text, /Robin/);
  assert.match(ctx2.sent[0].text, /do not leave messages/);
  assert.equal((await as('GET', '/api/staff/settings')).data.email_details, 'full');

  // Intake contact details are encrypted too.
  const yc = await ctx.browser()('POST', '/api/intake', { consent: true, age: 20, contact_ok: true, contact_method: 'text', contact_value: '5035550199', notes: 'private note' });
  const crow = ctx.app.db.prepare('SELECT contact_value, notes FROM clients WHERE ref_code = ?').get(yc.data.refCode);
  assert.match(crow.contact_value, /^enc1:/);
  assert.match(crow.notes, /^enc1:/);
  const detail = await as('GET', `/api/staff/clients/${yc.data.refCode}`);
  assert.equal(detail.data.client.contact_value, '5035550199');
});

test('refer me still saves when email is off or failing', async (t) => {
  const off = await start({ enforceAdmin2fa: false, mailer: null });
  t.after(off.close);
  const r = await off.browser()('POST', '/api/refer', { consent: true, contact_method: 'email', contact_value: 'me@example.org', program_name: 'SNAP food benefits' });
  assert.equal(r.status, 200);
  assert.equal(r.data.emailed, false);
  assert.equal((await off.browser()('GET', '/api/config')).data.referralEmail, 'ripchoom@gmail.com');

  const failing = await start({ enforceAdmin2fa: false, mailer: { send: async () => { throw new Error('SMTP 535: bad login'); }, describe: () => 'x' } });
  t.after(failing.close);
  const f = await failing.browser()('POST', '/api/refer', { consent: true, contact_method: 'call', contact_value: '503 555 0100' });
  assert.equal(f.status, 200);
  assert.equal(f.data.emailed, false);
  assert.match(failing.app.db.prepare('SELECT email_error FROM referral_requests').get().email_error, /535/);

  // Rate limit: 5 per hour per address.
  const b = off.browser();
  for (let i = 0; i < 4; i++) await b('POST', '/api/refer', { consent: true, contact_method: 'call', contact_value: '5035550100' });
  assert.equal((await b('POST', '/api/refer', { consent: true, contact_method: 'call', contact_value: '5035550100' })).status, 429);
});

test('screener: likely / maybe results with where and how, nothing saved', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false });
  t.after(ctx.close);
  const s = ctx.browser();
  const before = ctx.app.db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const r = await s('POST', '/api/screener', {
    age: 15, county: 'multnomah', household_size: 1, monthly_income: 0, flags: ['unhoused', 'lgbtq', 'east_county', 'in_high_school'],
  });
  assert.equal(r.status, 200);
  const ids = r.data.groups.flatMap((g) => g.programs.map((p) => p.id));
  for (const id of ['alba-24-7', 'hyc-access', 'nafy-drop-in', 'nafy-east-connect', 'nafy-smyrc', 'ohp', 'trimet'])
    assert.ok(ids.includes(id), `includes ${id}`);
  assert.ok(!ids.includes('nafy-new-day'), 'New Day only when exploitation is shared');
  assert.ok(!ids.includes('rent-assistance-211'), 'rent help needs 18+ and rent');
  const alba = r.data.groups.flatMap((g) => g.programs).find((p) => p.id === 'alba-24-7');
  assert.equal(alba.level, 'likely');
  assert.ok(alba.where[0].address.includes('165th'));
  assert.equal(r.data.groups[0].id, 'now');
  assert.equal(ctx.app.db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, before, 'nothing saved');

  // Income rules use the poverty guideline from settings.
  const snapAt = (income, hh = 1) =>
    benefits.screen({ age: 23, household_size: hh, monthly_income: income, flags: [] }).groups.flatMap((g) => g.programs).find((p) => p.id === 'snap');
  assert.equal(snapAt(2000).level, 'likely'); // ~153% FPL
  assert.equal(snapAt(3000), undefined); // ~230% FPL
  assert.equal(snapAt(3000, 3).level, 'likely'); // bigger household
  const foster = benefits.screen({ age: 21, monthly_income: 4000, flags: ['foster'] }).groups.flatMap((g) => g.programs).find((p) => p.id === 'ohp');
  assert.equal(foster.level, 'likely', 'former foster youth get OHP regardless of income');

  // Every referenced directory program exists, so "Refer me" can link to it.
  const known = new Set(ctx.app.db.prepare('SELECT id FROM resources').all().map((x) => x.id));
  for (const p of benefits.PROGRAMS) if (p.resource_id) assert.ok(known.has(p.resource_id), `${p.id} → ${p.resource_id}`);

  // Settings: maintainers update the poverty guideline each year.
  const as = ctx.browser();
  await as('POST', '/api/staff/login', { password: PASSWORD });
  assert.equal((await as('POST', '/api/staff/settings', { fpl: { year: 2026, base: 'x', perPerson: 1 } })).status, 400);
  assert.equal((await as('POST', '/api/staff/settings', { fpl: { year: 2026, base: 16000, perPerson: 5600 } })).status, 200);
  assert.equal((await s('POST', '/api/screener', { age: 20 })).data.fplYear, 2026);
});

test('retention removes old records', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false });
  t.after(ctx.close);
  const y = ctx.browser();
  const keep = await y('POST', '/api/intake', { consent: true, needs: ['food'] });
  const old = await y('POST', '/api/intake', { consent: true, needs: ['food'] });
  ctx.app.db.prepare("UPDATE clients SET created_at = datetime('now', '-400 days') WHERE ref_code = ?").run(old.data.refCode);
  const as = ctx.browser();
  await as('POST', '/api/staff/login', { password: PASSWORD });
  assert.equal((await as('POST', '/api/staff/settings', { retention_days: 10 })).status, 400);
  await as('POST', '/api/staff/settings', { retention_days: 365 });
  const r = await as('POST', '/api/staff/retention/run');
  assert.equal(r.data.clients, 1);
  assert.equal((await y('GET', `/api/followup/${keep.data.refCode}`)).status, 200);
  assert.equal((await y('GET', `/api/followup/${old.data.refCode}`)).status, 404);
});

test('legal pages are served', async (t) => {
  const ctx = await start({ enforceAdmin2fa: false });
  t.after(ctx.close);
  const g = ctx.browser();
  for (const p of ['/privacy', '/terms', '/disclaimer', '/qualify', '/security'])
    assert.equal((await g('GET', p)).status, 200, p);
  const h = (await g('GET', '/')).headers;
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(h.get('x-frame-options'), 'DENY');
});
