'use strict';

const fs = require('node:fs');
const path = require('node:path');
const T = require('./taxonomy');
const db_ = require('./db');
const store = require('./store');
const roles = require('./roles');
const benefits = require('./benefits');
const requests = require('./requests');
const { createAuth } = require('./auth');
const { createLive } = require('./live');
const { createDiscovery } = require('./discovery');
const { searchNeeds } = require('./matcher');
const { validateIntake, validateOutcome, validateResource, ValidationError } = require('./validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-DNS-Prefetch-Control': 'off',
};
// Added when SECURE_COOKIES=1 (the site is served over HTTPS).
const HSTS = { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' };
let extraHeaders = {};

const DEFAULT_REFERRAL_EMAIL = 'ripchoom@gmail.com';
const DEFAULT_RETENTION_DAYS = 1095; // 3 years

class HttpError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Pretty URLs: /staff → staff.html, /privacy → privacy.html, etc.
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(file)) file += '.html';
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...extraHeaders,
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// Public view of a resource for the directory page.
const publicResource = (r) => {
  const { verified_by, created_at, updated_at, active, edited, source, link_checked_at, ...rest } = r;
  return rest;
};

const resultsPayload = (r) => ({
  refCode: r.refCode,
  crisis: r.crisis,
  byNeed: r.byNeed,
  unmetNeeds: r.unmetNeeds,
  impliedNeeds: r.impliedNeeds,
  usedDefaults: r.usedDefaults,
});

function createApp({
  dbFile,
  staffPassword,
  sessionSecret,
  secureCookies = false,
  linkFetch = fetch,
  liveProviders = [],
  liveOptions = {},
  discoveryFetch = fetch,
  adminLogin = 'admin',
  bootstrapMustChange = false,
  mailer = null,
  publicUrl = null,
  referralEmail = null,
  emailDetails = null,
  vault = { enabled: false, seal: (v) => v, open: (v) => v },
  enforceAdmin2fa = true,
  staffAllowedIps = null, // e.g. ['203.0.113.7', '10.0.'] — exact IPs or prefixes
  trustProxy = false, // true when behind a reverse proxy that sets X-Forwarded-For
}) {
  const db = db_.open(dbFile);
  const seeded = db_.syncSeed(db);
  if (secureCookies) extraHeaders = HSTS;
  const auth = createAuth({ db, password: staffPassword, secret: sessionSecret, adminLogin, bootstrapMustChange, enforceAdmin2fa, secureCookies });

  // The address of the person making the request. Behind a proxy, the last
  // X-Forwarded-For entry is the one the proxy itself added (can't be faked).
  const ip = (req) => {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket?.remoteAddress || 'unknown';
  };
  const staffIpAllowed = (req) => {
    if (!staffAllowedIps || !staffAllowedIps.length) return true;
    const a = ip(req).replace(/^::ffff:/, '');
    return staffAllowedIps.some((p) => a === p || (p.endsWith('.') || p.endsWith(':') ? a.startsWith(p) : false));
  };

  // Check-in codes are the key to a youth's record, so guessing them is
  // throttled: 20 wrong codes from one address in an hour → blocked for an hour.
  const codeMisses = new Map();
  const codeGate = (req) => {
    const m = codeMisses.get(ip(req));
    if (m && m.length >= 20 && Date.now() - m[m.length - 1] < 3600 * 1000)
      throw new HttpError(429, 'Too many tries. Please wait an hour, or ask staff to look up your code.');
  };
  const codeMiss = (req) => {
    const k = ip(req);
    const list = (codeMisses.get(k) || []).filter((t) => Date.now() - t < 3600 * 1000);
    list.push(Date.now());
    codeMisses.set(k, list);
    if (list.length === 20) db_.audit(db, null, 'security.code_guessing', k.slice(0, 60));
    if (codeMisses.size > 10000) codeMisses.clear();
  };
  const clientByCode = (req, code) => {
    codeGate(req);
    const client = store.getClientByCode(db, code);
    if (!client) codeMiss(req);
    return client;
  };
  const live = createLive(db, { providers: liveProviders, ...liveOptions });
  const discovery = createDiscovery(db, { fetchImpl: discoveryFetch });

  // ---------- Settings (maintainers change these on the staff Settings tab) ----------
  const settings = () => ({
    referral_email: db_.getSetting(db, 'referral_email', referralEmail || DEFAULT_REFERRAL_EMAIL),
    email_details: db_.getSetting(db, 'email_details', emailDetails === 'full' ? 'full' : 'minimal'),
    retention_days: db_.getSetting(db, 'retention_days', DEFAULT_RETENTION_DAYS),
    require_2fa: db_.getSetting(db, 'require_2fa', false),
    fpl: db_.getSetting(db, 'fpl', benefits.DEFAULT_FPL),
    org_name: db_.getSetting(db, 'org_name', null),
  });

  // Simple per-IP limit for public forms that send email.
  const hits = new Map();
  function rateLimit(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) throw new HttpError(429, 'Too many requests — please wait a bit, or call 211 for help now.');
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
  }

  const audit = (req, action, target, detail) => db_.audit(db, req.user, action, target, detail);

  const routes = [];
  // opts.perm: permission from server/roles.js (implies signed in).
  // opts.staff: any signed-in staff member.
  // opts.pending: allowed before a required password change / 2FA setup.
  const route = (method, pattern, handler, { staff = false, perm = null, pending = false } = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
    );
    routes.push({ method, re, keys, handler, staff: staff || !!perm, perm, pending });
  };

  const resourceExists = (id) => !!db_.getResource(db, id);

  // ======================= Public =======================
  route('GET', '/api/taxonomy', () => T);

  route('GET', '/api/resources', () => db_.listResources(db).map(publicResource));

  // What the public pages need to know (no secrets).
  route('GET', '/api/config', () => {
    const s = settings();
    return { referralEmail: s.referral_email, emailEnabled: !!mailer, orgName: s.org_name, fplYear: s.fpl.year };
  });

  route('POST', '/api/intake', async (req) => {
    rateLimit(`intake:${ip(req)}`, 30, 60 * 60 * 1000);
    const profile = validateIntake(await readJson(req));
    const user = auth.fromRequest(req);
    const source = user && req.headers['x-intake-source'] === 'staff' ? 'staff' : 'self';
    // Kids under 13 don't give us contact details on their own.
    if (profile.age != null && profile.age < 13 && profile.contact_ok && source !== 'staff')
      throw new ValidationError(['For kids under 13, a staff member or trusted adult needs to share contact details. You can still search without them.']);
    // Pull fresh live listings for these needs first (cached; falls back to
    // saved listings if a directory is slow or down).
    if (live.enabled) await live.refreshNeeds(searchNeeds(profile));
    // Contact details and free-text notes are encrypted at rest (DATA_KEY).
    const r = store.createIntake(db, { ...profile, contact_value: vault.seal(profile.contact_value), notes: vault.seal(profile.notes) }, { source });
    return resultsPayload(r);
  });

  // "What do I qualify for?" — nothing entered here is saved.
  route('POST', '/api/screener', async (req) => {
    rateLimit(`screen:${ip(req)}`, 120, 60 * 60 * 1000);
    return benefits.screen(await readJson(req), { fpl: settings().fpl });
  });
  route('GET', '/api/benefits', () => benefits.catalog());

  // "Refer me": saved, then emailed to staff when email is set up.
  route('POST', '/api/refer', async (req) => {
    const body = await readJson(req);
    if (body.website) return { ok: true, id: null, emailed: false }; // honeypot: bots fill hidden fields
    rateLimit(`refer:${ip(req)}`, 5, 60 * 60 * 1000);
    rateLimit('refer:all', 200, 60 * 60 * 1000); // flood guard across all addresses
    const staffAssisted = !!auth.fromRequest(req) && req.headers['x-intake-source'] === 'staff';
    const clean = requests.validateRequest(body, { resourceExists, staffAssisted });
    const saved = requests.createRequest(db, clean, vault);
    const s = settings();
    let emailed = false;
    if (mailer) {
      const resource = saved.resource_id ? db_.getResource(db, saved.resource_id) : null;
      const msg = requests.emailFor(saved, {
        programName: resource?.name,
        details: s.email_details,
        staffUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/staff#requests` : null,
      });
      try {
        await mailer.send({ to: s.referral_email, subject: msg.subject, text: msg.text });
        requests.markEmailed(db, saved.id);
        emailed = true;
      } catch (err) {
        console.error('Referral email failed', err.message);
        requests.markEmailed(db, saved.id, err.message);
      }
    }
    return { ok: true, id: saved.id, emailed };
  });

  // A returning youth can re-run matching against today's directory (new
  // programs, verified details, recent outcomes), optionally with new needs.
  route('POST', '/api/followup/:code/refresh', async (req, { code }) => {
    const client = clientByCode(req, code);
    if (!client) throw new HttpError(404, 'Code not found');
    const { needs } = await readJson(req);
    const valid = needs == null ? null : validateIntake({ needs, consent: true }).needs;
    if (live.enabled) await live.refreshNeeds(searchNeeds({ ...client, needs: valid && valid.length ? valid : client.needs }));
    return resultsPayload({ ...store.refreshSearch(db, client, { needs: valid && valid.length ? valid : null }), refCode: client.ref_code });
  });

  // Follow-up by reference code: youth can see their referrals and report
  // what happened, but never see their demographic answers again.
  route('GET', '/api/followup/:code', (req, { code }) => {
    const client = clientByCode(req, code);
    if (!client) throw new HttpError(404, 'We couldn’t find that code. Check it and try again.');
    return { refCode: client.ref_code, createdAt: client.created_at, referrals: store.referralsFor(db, client.id) };
  });

  route('POST', '/api/followup/:code/referrals/:id', async (req, { code, id }) => {
    const client = clientByCode(req, code);
    if (!client) throw new HttpError(404, 'Code not found');
    const outcome = validateOutcome(await readJson(req));
    if (!store.recordOutcome(db, Number(id), client.id, outcome, 'youth')) throw new HttpError(404, 'Referral not found');
    return { ok: true };
  });

  // Right to delete: anyone with the code can erase that record themselves.
  route('DELETE', '/api/followup/:code', (req, { code }) => {
    rateLimit(`del:${ip(req)}`, 10, 60 * 60 * 1000);
    if (!clientByCode(req, code)) throw new HttpError(404, 'Code not found');
    store.deleteClient(db, code);
    db_.audit(db, null, 'youth.self_delete', null, null);
    return { ok: true };
  });

  // ======================= Staff: sign in & own account =======================
  route('POST', '/api/staff/login', async (req, _p, res) => {
    const body = await readJson(req);
    const result = auth.login(body, ip(req));
    if (result.user && !result.ok) db_.audit(db, result.user, result.locked ? 'login.locked' : result.badCode ? 'login.bad_code' : 'login.failed', null, ip(req));
    if (result.accountLocked) db_.audit(db, result.user, 'security.account_locked', null, 'Many failed sign-ins from several places');
    if (result.locked) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (result.needCode && !result.badCode) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', { needCode: true });
    if (result.badCode) throw new HttpError(401, 'That code didn’t work. Use the newest code.', { needCode: true });
    if (!result.ok) throw new HttpError(401, auth.multiUser ? 'Wrong email or password' : 'Wrong password');
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue(result.user), secureCookies));
    db_.audit(db, result.user, 'login', null, ip(req));
    return { ok: true, user: result.user };
  });

  route('POST', '/api/staff/logout', (req, _p, res) => {
    res.setHeader('Set-Cookie', auth.cookieHeader('', secureCookies));
    return { ok: true };
  });

  route('GET', '/api/staff/me', (req) => {
    const user = auth.fromRequest(req);
    return {
      staff: !!user,
      user: user || null,
      multiUser: !!auth.multiUser,
      roles: roles.ROLES,
      openRequests: user && roles.can(user, 'requests.view')
        ? requests.countOpen(db, roles.can(user, 'requests.all') ? null : user.programs)
        : 0,
    };
  });

  route('POST', '/api/staff/account/password', async (req, _p, res) => {
    const { current, next } = await readJson(req);
    const user = auth.changeOwnPassword(req.user, current, next);
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue(user), secureCookies));
    audit(req, 'account.password_changed', user.email);
    return { ok: true };
  }, { staff: true, pending: true });

  route('POST', '/api/staff/account/2fa/begin', (req) => auth.totpBegin(req.user), { staff: true, pending: true });

  route('POST', '/api/staff/account/2fa/enable', async (req) => {
    const { code } = await readJson(req);
    auth.totpEnable(req.user, code);
    audit(req, 'account.2fa_on', req.user.email);
    return { ok: true };
  }, { staff: true, pending: true });

  route('POST', '/api/staff/account/2fa/disable', async (req) => {
    const { password } = await readJson(req);
    auth.totpDisable(req.user, password);
    audit(req, 'account.2fa_off', req.user.email);
    return { ok: true };
  }, { staff: true });

  route('POST', '/api/staff/account/logout-all', (req, _p, res) => {
    auth.logoutEverywhere(req.user);
    res.setHeader('Set-Cookie', auth.cookieHeader('', secureCookies));
    audit(req, 'account.logout_all', req.user.email);
    return { ok: true };
  }, { staff: true, pending: true });

  // ======================= Staff: accounts (architect / maintenance) =======================
  route('GET', '/api/staff/users', () => auth.listUsers(), { perm: 'users.manage' });

  route('POST', '/api/staff/users', async (req) => {
    const out = auth.createUser(req.user, await readJson(req));
    audit(req, 'user.create', out.user.email, { role: out.user.role, programs: out.user.programs });
    return out;
  }, { perm: 'users.manage' });

  route('POST', '/api/staff/users/:id', async (req, { id }) => {
    const user = auth.updateUser(req.user, id, await readJson(req));
    audit(req, 'user.update', user.email, { role: user.role, active: user.active, programs: user.programs });
    return user;
  }, { perm: 'users.manage' });

  route('POST', '/api/staff/users/:id/reset-password', (req, { id }) => {
    const out = auth.resetPassword(req.user, id);
    audit(req, 'user.reset_password', id);
    return out;
  }, { perm: 'users.manage' });

  route('POST', '/api/staff/users/:id/reset-2fa', (req, { id }) => {
    auth.resetTotp(req.user, id);
    audit(req, 'user.reset_2fa', id);
    return { ok: true };
  }, { perm: 'users.manage' });

  route('GET', '/api/staff/audit', (_req, _p, _res, url) =>
    db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(url.searchParams.get('limit')) || 300, 2000)),
  { perm: 'audit.view' });

  route('GET', '/api/staff/settings', () => ({ ...settings(), emailEnabled: !!mailer, emailFrom: mailer?.describe?.() || null }), { perm: 'settings.edit' });

  route('POST', '/api/staff/settings', async (req) => {
    const b = await readJson(req);
    const errors = [];
    const changes = {};
    if (b.referral_email !== undefined) {
      const e = String(b.referral_email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errors.push('Enter a valid staff email');
      else changes.referral_email = e;
    }
    if (b.email_details !== undefined) {
      if (!['minimal', 'full'].includes(b.email_details)) errors.push('Unknown email setting');
      else changes.email_details = b.email_details;
    }
    if (b.retention_days !== undefined) {
      const n = Number(b.retention_days);
      if (!Number.isInteger(n) || n < 30 || n > 3650) errors.push('Keep records between 30 and 3650 days');
      else changes.retention_days = n;
    }
    if (b.require_2fa !== undefined) {
      if (b.require_2fa === true && req.user.role !== 'architect') errors.push('Only a main architect can require two-step sign-in');
      else changes.require_2fa = b.require_2fa === true;
    }
    if (b.fpl !== undefined) {
      const f = b.fpl || {};
      const year = Number(f.year);
      const base = Number(f.base);
      const per = Number(f.perPerson);
      if (!Number.isInteger(year) || year < 2020 || year > 2100 || !(base > 5000 && base < 100000) || !(per > 1000 && per < 50000))
        errors.push('Check the poverty guideline numbers');
      else changes.fpl = { year, base, perPerson: per };
    }
    if (b.org_name !== undefined) changes.org_name = String(b.org_name || '').trim().slice(0, 120) || null;
    if (errors.length) throw new ValidationError(errors);
    for (const [k, v] of Object.entries(changes)) db_.setSetting(db, k, v, req.user.email);
    audit(req, 'settings.update', null, changes);
    return { ...settings(), emailEnabled: !!mailer };
  }, { perm: 'settings.edit' });

  // Sends a test message to the staff inbox.
  route('POST', '/api/staff/settings/test-email', async (req) => {
    if (!mailer) throw new HttpError(400, 'Email isn’t set up on this server. See README → Refer me emails.');
    await mailer.send({ to: settings().referral_email, subject: 'Bridge Out of Poverty: test email', text: `Email is working. Sent by ${req.user.name}.` });
    return { ok: true };
  }, { perm: 'settings.edit' });

  route('POST', '/api/staff/retention/run', (req) => {
    const r = purgeExpired();
    audit(req, 'retention.run', null, r);
    return r;
  }, { perm: 'settings.edit' });

  // ======================= Staff: Refer-me requests =======================
  const requestScope = (user) => (roles.can(user, 'requests.all') ? null : user.programs);
  const assertRequestAccess = (user, reqRow) => {
    if (!reqRow) throw new HttpError(404, 'Request not found');
    const scope = requestScope(user);
    if (scope && !scope.includes(reqRow.resource_id)) throw new HttpError(404, 'Request not found');
  };

  route('GET', '/api/staff/requests', (req, _p, _res, url) => {
    const list = requests.listRequests(db, { status: url.searchParams.get('status') || 'open', resourceIds: requestScope(req.user), vault });
    audit(req, 'requests.view', null, { count: list.length });
    return { requests: list, statuses: requests.STATUSES };
  }, { perm: 'requests.view' });

  route('POST', '/api/staff/requests/:id', async (req, { id }) => {
    assertRequestAccess(req.user, requests.getRequest(db, Number(id)));
    const r = requests.updateRequest(db, Number(id), await readJson(req), req.user, vault);
    audit(req, 'request.update', id, { status: r.status });
    return r;
  }, { perm: 'requests.view' });

  route('DELETE', '/api/staff/requests/:id', (req, { id }) => {
    assertRequestAccess(req.user, requests.getRequest(db, Number(id)));
    requests.deleteRequest(db, Number(id));
    audit(req, 'request.delete', id);
    return { ok: true };
  }, { perm: 'requests.view' });

  // ======================= Staff: youth records =======================
  route('GET', '/api/staff/dashboard', (req, _p, _res, url) =>
    store.dashboard(db, {
      from: url.searchParams.get('from') || null,
      to: url.searchParams.get('to') || null,
      county: url.searchParams.get('county') || null,
    }), { perm: 'dashboard.view' });

  route('GET', '/api/staff/clients', (_req, _p, _res, url) =>
    store.listClients(db, { q: url.searchParams.get('q'), limit: url.searchParams.get('limit') }), { perm: 'youth.view' });

  route('GET', '/api/staff/clients/:code', (req, { code }) => {
    const client = store.getClientByCode(db, code);
    if (!client) throw new HttpError(404, 'Client not found');
    audit(req, 'youth.view', client.ref_code);
    client.contact_value = vault.open(client.contact_value);
    client.notes = vault.open(client.notes);
    return { client, referrals: store.referralsFor(db, client.id), events: store.eventsFor(db, client.id) };
  }, { perm: 'youth.view' });

  route('DELETE', '/api/staff/clients/:code', (req, { code }) => {
    if (!store.deleteClient(db, code)) throw new HttpError(404, 'Client not found');
    audit(req, 'youth.delete', String(code).toUpperCase());
    return { ok: true };
  }, { perm: 'youth.delete' });

  route('POST', '/api/staff/referrals/:id', async (req, { id }) => {
    const outcome = validateOutcome(await readJson(req));
    if (!store.recordOutcome(db, Number(id), null, outcome, 'staff')) throw new HttpError(404, 'Referral not found');
    audit(req, 'referral.update', id, { status: outcome.status });
    return { ok: true };
  }, { perm: 'youth.edit' });

  route('POST', '/api/staff/referrals/:id/validate', async (req, { id }) => {
    const { verified_by, note } = await readJson(req);
    const by = String(verified_by || '').trim().slice(0, 100) || (auth.multiUser ? req.user.name : '');
    if (!by) throw new HttpError(400, 'Add your name or initials');
    if (!store.validateReferral(db, Number(id), { by, note: note ? String(note).slice(0, 1000) : null }))
      throw new HttpError(404, 'Referral not found');
    audit(req, 'referral.validate', id);
    return { ok: true };
  }, { perm: 'youth.edit' });

  route('POST', '/api/staff/referrals/:id/unvalidate', (req, { id }) => {
    if (!store.unvalidateReferral(db, Number(id))) throw new HttpError(404, 'Referral not found');
    audit(req, 'referral.unvalidate', id);
    return { ok: true };
  }, { perm: 'youth.edit' });

  // ======================= Staff: directory =======================
  // Pull in programs added to the starter list since this database was made.
  // With updateExisting, entries nobody has edited or verified get the latest
  // starter details too.
  route('POST', '/api/staff/resources/refresh', async (req) => {
    const { updateExisting } = await readJson(req);
    const r = db_.mergeResources(db, db_.readSeed(), { updateExisting: updateExisting === true, source: 'seed' });
    audit(req, 'resources.refresh', null, r);
    return r;
  }, { perm: 'resources.bulk' });

  route('POST', '/api/staff/resources/import', async (req) => {
    const { resources, updateExisting } = await readJson(req, 2 * 1024 * 1024);
    if (!Array.isArray(resources) || !resources.length) throw new HttpError(400, 'Expected a list of resources');
    const clean = [];
    const errors = [];
    resources.forEach((r, i) => {
      try {
        clean.push(validateResource(r));
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        errors.push(`#${i + 1} ${r?.name || ''}: ${err.errors.join('; ')}`);
      }
    });
    if (errors.length) throw new ValidationError(errors.slice(0, 20));
    const r = db_.mergeResources(db, clean, { updateExisting: updateExisting === true, source: 'import' });
    audit(req, 'resources.import', null, r);
    return r;
  }, { perm: 'resources.bulk' });

  route('POST', '/api/staff/resources/check-links', () => store.checkLinks(db, { fetchImpl: linkFetch }), { perm: 'resources.edit_all' });

  route('POST', '/api/staff/resources/:id/partner', async (req, { id }) => {
    const existing = db_.getResource(db, id);
    if (!existing) throw new HttpError(404, 'Resource not found');
    const { partner } = await readJson(req);
    const flags = existing.flags.filter((f) => f !== 'partner');
    if (partner) flags.push('partner');
    audit(req, partner ? 'resource.favor' : 'resource.unfavor', id);
    return db_.upsertResource(db, { ...existing, flags }, { edited: 1 });
  }, { perm: 'resources.edit_all' });

  route('GET', '/api/staff/live', () => live.status(), { perm: 'resources.edit_all' });

  route('POST', '/api/staff/live/sync', async () => {
    if (!live.enabled) throw new HttpError(400, 'No live directory is set up. See README → Live lookup.');
    return live.syncAll();
  }, { perm: 'resources.edit_all' });

  // ---------- Discovery (public records → leads for review) ----------
  route('GET', '/api/staff/discovery/sources', () => discovery.listSources(), { perm: 'discovery' });

  route('GET', '/api/staff/discovery/leads', (_req, _p, _res, url) =>
    discovery.listLeads({
      status: url.searchParams.get('status') || 'new',
      q: url.searchParams.get('q') || null,
      need: url.searchParams.get('need') || null,
    }), { perm: 'discovery' });

  route('POST', '/api/staff/discovery/sources', async (req) => {
    const b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 200);
    let url;
    try {
      url = new URL(String(b.url || ''));
    } catch {
      throw new HttpError(400, 'Enter a full web address (https://…)');
    }
    if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Web address must start with http:// or https://');
    if (!name) throw new HttpError(400, 'Give the page a name');
    const needs = validateIntake({ needs: Array.isArray(b.needs) ? b.needs : [], consent: true }).needs;
    return discovery.addWebpageSource({ name, url: url.href, needs, network: b.network === true });
  }, { perm: 'discovery' });

  route('POST', '/api/staff/discovery/sources/:id/run', async (_req, { id }) => {
    const r = await discovery.runSource(id);
    if (!r) throw new HttpError(404, 'Source not found');
    return r;
  }, { perm: 'discovery' });

  route('POST', '/api/staff/discovery/sources/:id/enabled', async (req, { id }) => {
    const { enabled } = await readJson(req);
    if (!discovery.setSourceEnabled(id, enabled === true)) throw new HttpError(404, 'Source not found');
    return { ok: true };
  }, { perm: 'discovery' });

  route('DELETE', '/api/staff/discovery/sources/:id', (_req, { id }) => {
    if (!discovery.deleteSource(id)) throw new HttpError(400, 'Built-in sources can be turned off but not deleted');
    return { ok: true };
  }, { perm: 'discovery' });

  route('POST', '/api/staff/discovery/run-all', () => discovery.runAll(), { perm: 'discovery' });

  route('POST', '/api/staff/discovery/leads/:id/dismiss', async (req, { id }) => {
    const { note } = await readJson(req);
    if (!discovery.setLeadStatus(Number(id), 'dismissed', { note: note ? String(note).slice(0, 500) : null }))
      throw new HttpError(404, 'Lead not found');
    return { ok: true };
  }, { perm: 'discovery' });

  route('POST', '/api/staff/discovery/leads/:id/restore', async (_req, { id }) => {
    const lead = discovery.getLead(Number(id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    discovery.setLeadStatus(lead.id, lead.resource_id ? 'known' : 'new');
    return { ok: true };
  }, { perm: 'discovery' });

  // Staff reviewed a lead and turned it into a directory program.
  route('POST', '/api/staff/discovery/leads/:id/add', async (req, { id }) => {
    const lead = discovery.getLead(Number(id));
    if (!lead) throw new HttpError(404, 'Lead not found');
    const r = validateResource(await readJson(req));
    if (db_.getResource(db, r.id)) throw new HttpError(409, 'A program with that ID already exists — edit the name or ID');
    const saved = db_.upsertResource(db, r, { edited: 1, source: 'discovered' });
    discovery.setLeadStatus(lead.id, 'added', { resourceId: saved.id });
    audit(req, 'resource.create', saved.id, 'from discovery lead');
    return saved;
  }, { perm: 'discovery' });

  route('GET', '/api/staff/resources/:id/records', (_req, { id }) => discovery.evidenceForResource(id), { perm: 'discovery' });

  // Program staff see only their own programs.
  route('GET', '/api/staff/resources', (req) => {
    const stats = store.resourceStats(db);
    const all = roles.can(req.user, 'resources.edit_all');
    return db_
      .listResources(db, { includeInactive: true })
      .filter((r) => all || req.user.programs.includes(r.id))
      .map((r) => ({ ...r, stats: stats[r.id] || null }));
  }, { perm: 'resources.view' });

  route('POST', '/api/staff/resources', async (req) => {
    const r = validateResource(await readJson(req));
    const existing = db_.getResource(db, r.id);
    if (!existing && !roles.can(req.user, 'resources.edit_all')) throw new HttpError(403, 'Ask a case worker or maintainer to add new programs');
    if (existing && !roles.canEditResource(req.user, r.id)) throw new HttpError(403, 'You can only edit your own program');
    // Only directory staff decide "Partner" and "general line" status.
    if (existing && !roles.can(req.user, 'resources.edit_all')) {
      const keep = existing.flags.filter((f) => f === 'partner' || f === 'general');
      r.flags = [...r.flags.filter((f) => f !== 'partner' && f !== 'general'), ...keep];
    }
    const saved = db_.upsertResource(db, r, existing ? { edited: 1 } : { edited: 1, source: 'staff' });
    audit(req, existing ? 'resource.update' : 'resource.create', r.id);
    return saved;
  }, { perm: 'resources.edit_own' });

  route('POST', '/api/staff/resources/:id/verify', async (req, { id }) => {
    const existing = db_.getResource(db, id);
    if (!existing) throw new HttpError(404, 'Resource not found');
    if (!roles.canEditResource(req.user, id)) throw new HttpError(403, 'You can only verify your own program');
    const { verified_by } = await readJson(req);
    audit(req, 'resource.verify', id);
    return db_.upsertResource(db, {
      ...existing,
      last_verified: new Date().toISOString().slice(0, 10),
      verified_by: String(verified_by || (auth.multiUser ? req.user.name : '') || 'staff').slice(0, 100),
    });
  }, { perm: 'resources.edit_own' });

  route('GET', '/api/staff/export/referrals.csv', (req) => {
    audit(req, 'export.referrals');
    return {
      raw: store.exportReferralsCsv(db),
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="referrals.csv"' },
    };
  }, { perm: 'export' });

  route('GET', '/api/staff/export/resources.json', () => ({
    raw: JSON.stringify(db_.listResources(db, { includeInactive: true }), null, 2),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="resources.json"' },
  }), { perm: 'resources.view' });

  // ---------- Data retention ----------
  // Deletes youth records and Refer-me requests older than the retention
  // period, and audit entries older than twice that. Runs daily (index.js).
  function purgeExpired() {
    const days = Number(settings().retention_days) || DEFAULT_RETENTION_DAYS;
    const cut = `-${days} days`;
    const clients = db.prepare("DELETE FROM clients WHERE created_at < datetime('now', ?)").run(cut).changes;
    const reqs = db.prepare("DELETE FROM referral_requests WHERE created_at < datetime('now', ?)").run(cut).changes;
    const logs = db.prepare("DELETE FROM audit_log WHERE at < datetime('now', ?)").run(`-${days * 2} days`).changes;
    return { days, clients, requests: reqs, auditEntries: logs };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, 'Bad URL');
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
        return serveStatic(req, res, pathname);
      }
      // State-changing requests must come from our own pages (CSRF guard on
      // top of SameSite cookies): JSON only, and if the browser says where
      // the request came from, it must be this site.
      if (req.method !== 'GET' && req.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new HttpError(415, 'Expected application/json');
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && origin !== 'null') {
        let host = null;
        try {
          host = new URL(origin).host;
        } catch {}
        if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
      }
      if (pathname.startsWith('/api/staff/') && !staffIpAllowed(req)) {
        db_.audit(db, null, 'security.staff_ip_blocked', pathname.slice(0, 80), ip(req).slice(0, 60));
        throw new HttpError(404, 'Not found');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.staff) {
          const user = auth.fromRequest(req);
          if (!user) throw new HttpError(401, 'Staff sign-in required');
          const fresh = auth.refreshCookie(user);
          if (fresh && !res.getHeader?.('Set-Cookie')) res.setHeader('Set-Cookie', fresh);
          if (!r.pending && user.must_change_password) throw new HttpError(403, 'Choose a new password first', { mustChangePassword: true });
          if (!r.pending && user.needs_2fa_setup) throw new HttpError(403, 'Set up two-step sign-in first', { needs2fa: true });
          if (r.perm && !roles.can(user, r.perm)) throw new HttpError(403, 'Your account doesn’t have access to this');
          req.user = user;
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const out = await r.handler(req, params, res, url);
        if (out && out.raw != null) return send(res, 200, out.raw, out.headers);
        return send(res, 200, out);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: 'Please check your answers', details: err.errors });
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
      if (err && err.expose) return send(res, err.status || 400, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  }

  return { handle, db, seeded, live, discovery, auth, purgeExpired, settings };
}

module.exports = { createApp };
