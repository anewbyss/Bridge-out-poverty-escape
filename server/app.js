'use strict';

const fs = require('node:fs');
const path = require('node:path');
const T = require('./taxonomy');
const db_ = require('./db');
const store = require('./store');
const { createAuth } = require('./auth');
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
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
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

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  if (file === '/staff') file = '/staff.html';
  if (file === '/followup') file = '/followup.html';
  if (file === '/directory') file = '/directory.html';
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
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

function createApp({ dbFile, staffPassword, sessionSecret, secureCookies = false, linkFetch = fetch }) {
  const db = db_.open(dbFile);
  const seeded = db_.syncSeed(db);
  const auth = createAuth({ password: staffPassword, secret: sessionSecret });

  const routes = [];
  const route = (method, pattern, handler, { staff = false } = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$'
    );
    routes.push({ method, re, keys, handler, staff });
  };

  // ---------- Public ----------
  route('GET', '/api/taxonomy', () => T);

  route('GET', '/api/resources', () => db_.listResources(db).map(publicResource));

  route('POST', '/api/intake', async (req) => {
    const profile = validateIntake(await readJson(req));
    const source = auth.fromRequest(req) && req.headers['x-intake-source'] === 'staff' ? 'staff' : 'self';
    const r = store.createIntake(db, profile, { source });
    return resultsPayload(r);
  });

  // A returning youth can re-run matching against today's directory (new
  // programs, verified details, recent outcomes), optionally with new needs.
  route('POST', '/api/followup/:code/refresh', async (req, { code }) => {
    const client = store.getClientByCode(db, code);
    if (!client) throw new HttpError(404, 'Code not found');
    const { needs } = await readJson(req);
    const valid = needs == null ? null : validateIntake({ needs, consent: true }).needs;
    return resultsPayload({ ...store.refreshSearch(db, client, { needs: valid && valid.length ? valid : null }), refCode: client.ref_code });
  });

  // Follow-up by reference code: youth can see their referrals and report
  // what happened, but never see their demographic answers again.
  route('GET', '/api/followup/:code', (req, { code }) => {
    const client = store.getClientByCode(db, code);
    if (!client) throw new HttpError(404, 'We couldn’t find that code. Check it and try again.');
    return { refCode: client.ref_code, createdAt: client.created_at, referrals: store.referralsFor(db, client.id) };
  });

  route('POST', '/api/followup/:code/referrals/:id', async (req, { code, id }) => {
    const client = store.getClientByCode(db, code);
    if (!client) throw new HttpError(404, 'Code not found');
    const outcome = validateOutcome(await readJson(req));
    if (!store.recordOutcome(db, Number(id), client.id, outcome, 'youth')) throw new HttpError(404, 'Referral not found');
    return { ok: true };
  });

  // ---------- Staff ----------
  route('POST', '/api/staff/login', async (req, _p, res) => {
    const { password } = await readJson(req);
    const result = auth.checkPassword(password || '', req.socket.remoteAddress);
    if (result.locked) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (!result.ok) throw new HttpError(401, 'Wrong password');
    res.setHeader('Set-Cookie', auth.cookieHeader(auth.issue(), secureCookies));
    return { ok: true };
  });

  route('POST', '/api/staff/logout', (_req, _p, res) => {
    res.setHeader('Set-Cookie', auth.cookieHeader('', secureCookies));
    return { ok: true };
  });

  route('GET', '/api/staff/me', (req) => ({ staff: !!auth.fromRequest(req) }));

  route('GET', '/api/staff/dashboard', (req, _p, _res, url) =>
    store.dashboard(db, {
      from: url.searchParams.get('from') || null,
      to: url.searchParams.get('to') || null,
      county: url.searchParams.get('county') || null,
    }), { staff: true });

  route('GET', '/api/staff/clients', (_req, _p, _res, url) =>
    store.listClients(db, { q: url.searchParams.get('q'), limit: url.searchParams.get('limit') }), { staff: true });

  route('GET', '/api/staff/clients/:code', (_req, { code }) => {
    const client = store.getClientByCode(db, code);
    if (!client) throw new HttpError(404, 'Client not found');
    return { client, referrals: store.referralsFor(db, client.id), events: store.eventsFor(db, client.id) };
  }, { staff: true });

  route('DELETE', '/api/staff/clients/:code', (_req, { code }) => {
    if (!store.deleteClient(db, code)) throw new HttpError(404, 'Client not found');
    return { ok: true };
  }, { staff: true });

  route('POST', '/api/staff/referrals/:id', async (req, { id }) => {
    const outcome = validateOutcome(await readJson(req));
    if (!store.recordOutcome(db, Number(id), null, outcome, 'staff')) throw new HttpError(404, 'Referral not found');
    return { ok: true };
  }, { staff: true });

  route('POST', '/api/staff/referrals/:id/validate', async (req, { id }) => {
    const { verified_by, note } = await readJson(req);
    const by = String(verified_by || '').trim().slice(0, 100);
    if (!by) throw new HttpError(400, 'Add your name or initials');
    if (!store.validateReferral(db, Number(id), { by, note: note ? String(note).slice(0, 1000) : null }))
      throw new HttpError(404, 'Referral not found');
    return { ok: true };
  }, { staff: true });

  route('POST', '/api/staff/referrals/:id/unvalidate', (_req, { id }) => {
    if (!store.unvalidateReferral(db, Number(id))) throw new HttpError(404, 'Referral not found');
    return { ok: true };
  }, { staff: true });

  // Pull in programs added to the starter list since this database was made.
  // With updateExisting, entries nobody has edited or verified get the latest
  // starter details too.
  route('POST', '/api/staff/resources/refresh', async (req) => {
    const { updateExisting } = await readJson(req);
    return db_.mergeResources(db, db_.readSeed(), { updateExisting: updateExisting === true, source: 'seed' });
  }, { staff: true });

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
    return db_.mergeResources(db, clean, { updateExisting: updateExisting === true, source: 'import' });
  }, { staff: true });

  route('POST', '/api/staff/resources/check-links', () => store.checkLinks(db, { fetchImpl: linkFetch }), { staff: true });

  route('POST', '/api/staff/resources/:id/partner', async (req, { id }) => {
    const existing = db_.getResource(db, id);
    if (!existing) throw new HttpError(404, 'Resource not found');
    const { partner } = await readJson(req);
    const flags = existing.flags.filter((f) => f !== 'partner');
    if (partner) flags.push('partner');
    return db_.upsertResource(db, { ...existing, flags }, { edited: 1 });
  }, { staff: true });

  route('GET', '/api/staff/resources', () => {
    const stats = store.resourceStats(db);
    return db_.listResources(db, { includeInactive: true }).map((r) => ({ ...r, stats: stats[r.id] || null }));
  }, { staff: true });

  route('POST', '/api/staff/resources', async (req) => {
    const r = validateResource(await readJson(req));
    const isNew = !db_.getResource(db, r.id);
    return db_.upsertResource(db, r, isNew ? { edited: 1, source: 'staff' } : { edited: 1 });
  }, { staff: true });

  route('POST', '/api/staff/resources/:id/verify', async (req, { id }) => {
    const existing = db_.getResource(db, id);
    if (!existing) throw new HttpError(404, 'Resource not found');
    const { verified_by } = await readJson(req);
    return db_.upsertResource(db, {
      ...existing,
      last_verified: new Date().toISOString().slice(0, 10),
      verified_by: String(verified_by || 'staff').slice(0, 100),
    });
  }, { staff: true });

  route('GET', '/api/staff/export/referrals.csv', () => ({
    raw: store.exportReferralsCsv(db),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="referrals.csv"' },
  }), { staff: true });

  route('GET', '/api/staff/export/resources.json', () => ({
    raw: JSON.stringify(db_.listResources(db, { includeInactive: true }), null, 2),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="resources.json"' },
  }), { staff: true });

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
      // top of SameSite cookies).
      if (req.method !== 'GET' && req.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new HttpError(415, 'Expected application/json');
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.staff && !auth.fromRequest(req)) throw new HttpError(401, 'Staff sign-in required');
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const out = await r.handler(req, params, res, url);
        if (out && out.raw != null) return send(res, 200, out.raw, out.headers);
        return send(res, 200, out);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof ValidationError) return send(res, 400, { error: 'Please check your answers', details: err.errors });
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  }

  return { handle, db, seeded };
}

module.exports = { createApp };
