'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

test('phone app builds and its bundled engine runs on sql.js', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bop-site-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-mobile.js'), out]);
  for (const f of ['index.html', 'staff.html', 'engine.js', 'shell.js', 'sw.js', 'manifest.webmanifest', 'vendor/sql-wasm.wasm', 'icons/icon-180.png'])
    assert.ok(fs.existsSync(path.join(out, f)), f);
  const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(index, /apple-touch-icon/);
  assert.match(index, /<script src="engine\.js" defer>/);

  // Run the bundle the way a browser would.
  const SQL = await require('sql.js')();
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, URL, URLSearchParams, AbortSignal, fetch, setTimeout, queueMicrotask, btoa,
    crypto: { getRandomValues: (a) => crypto.getRandomValues(a) },
    localStorage: mem(), sessionStorage: mem(),
  });
  ctx.globalThis = ctx;
  ctx.__BOP = { SQL, seedText: fs.readFileSync(path.join(ROOT, 'data/resources.seed.json'), 'utf8') };
  vm.runInContext(`${fs.readFileSync(path.join(out, 'engine.js'), 'utf8')}; globalThis.BOP_ENGINE = BOP_ENGINE;`, ctx);

  // The shim's SHA-256 matches Node's.
  const shims = ctx.BOP_ENGINE.require('/mobile/shims');
  for (const s of ['', 'abc', 'x'.repeat(1000), 'héllo 🌉'])
    assert.equal(shims.sha256Hex(s), crypto.createHash('sha256').update(s).digest('hex'));

  const app = ctx.BOP_ENGINE.require('/server/app').createApp({ dbFile: 'device.db', staffPassword: '' });
  const call = (method, url, body) =>
    new Promise((resolve) => {
      const bytes = body ? new TextEncoder().encode(JSON.stringify(body)) : null;
      const req = {
        method, url, headers: body ? { 'content-type': 'application/json' } : {}, socket: {}, destroy() {},
        on(ev, cb) {
          if (ev === 'data') this.d = cb;
          if (ev === 'end') queueMicrotask(() => (bytes && this.d(bytes), cb()));
          return req;
        },
      };
      const res = { status: 200, setHeader() {}, writeHead(s) { res.status = s; }, end(b) { resolve({ status: res.status, data: JSON.parse(b) }); } };
      app.handle(req, res);
    });

  const r = await call('POST', '/api/intake', { consent: true, age: 18, county: 'multnomah', needs: ['rent_assistance'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.byNeed[0].matches.length > 0);
  assert.equal((await call('GET', '/api/staff/dashboard')).status, 401);
  // First passcode is set, then required.
  assert.equal((await call('POST', '/api/staff/login', { password: '13579' })).status, 200);
  const dash = await call('GET', '/api/staff/dashboard');
  assert.equal(dash.data.totals.clients, 1);
  ctx.sessionStorage.removeItem('bop.session');
  assert.equal((await call('POST', '/api/staff/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/staff/login', { password: '13579' })).status, 200);

  // The database survives export/import (how the phone saves it).
  const bytes = ctx.__BOP.db.export();
  const reopened = new SQL.Database(bytes);
  assert.equal(reopened.exec('SELECT COUNT(*) FROM clients')[0].values[0][0], 1);
});
