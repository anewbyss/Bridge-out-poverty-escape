'use strict';

// Runs the app on the phone. The server's own request handler runs here
// against a SQLite database kept in IndexedDB, and the pages talk to it
// through window.LOCAL_API instead of the network. Nothing about young people
// leaves the device.

(function () {
  const DB_NAME = 'bridge-out-of-poverty';
  const UPDATE_EVERY_MS = 24 * 3600 * 1000;

  // ---------- IndexedDB: one record holding the database file ----------
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('files');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('files', mode);
        const req = fn(tx.objectStore('files'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const loadBytes = () => idb('readonly', (s) => s.get('db')).catch(() => null);
  const saveBytes = (bytes) => idb('readwrite', (s) => s.put(bytes, 'db'));

  const local = (k, v) => {
    try {
      if (v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v);
    } catch {}
    return null;
  };

  let app;
  let saving = Promise.resolve();
  function persist() {
    saving = saving.then(() => saveBytes(globalThis.__BOP.db.export())).catch((err) => console.error('Save failed', err));
    return saving;
  }

  const ready = (async () => {
    const [SQL, dbBytes, seedText] = await Promise.all([
      initSqlJs({ locateFile: (f) => `vendor/${f}` }),
      loadBytes(),
      fetch('data/resources.seed.json').then((r) => r.text()),
    ]);
    globalThis.__BOP = { SQL, dbBytes, seedText };
    const { createApp } = BOP_ENGINE.require('/server/app');
    app = createApp({
      dbFile: 'device.db',
      staffPassword: '',
      linkFetch: publishedLinkFetch,
    });
    adaptDiscovery(app.discovery);
    try {
      if (navigator.storage?.persist) await navigator.storage.persist();
    } catch {}
    await persist();
    if (navigator.onLine && Date.now() - Number(local('bop.updated') || 0) > UPDATE_EVERY_MS) getUpdates().catch(() => {});
    return app;
  })();

  // ---------- Request bridge ----------
  async function localApi(path, { method = 'GET', headers = {}, body } = {}) {
    await ready;
    const bytes = body == null ? null : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const listeners = { data: [], end: [], error: [] };
    const req = {
      method,
      url: path,
      headers: h,
      socket: { remoteAddress: 'device' },
      destroy() {},
      on(ev, cb) {
        listeners[ev]?.push(cb);
        if (ev === 'end')
          queueMicrotask(() => {
            if (bytes) listeners.data.forEach((d) => d(bytes));
            cb();
          });
        return req;
      },
    };
    const out = { status: 200, headers: {}, body: '' };
    const res = {
      setHeader: (k, v) => (out.headers[k] = v),
      writeHead(status, hdrs) {
        out.status = status;
        Object.assign(out.headers, hdrs);
      },
      end(b) {
        out.body = b == null ? '' : b;
      },
    };
    await app.handle(req, res);
    if (method !== 'GET' && out.status < 400) await persist();
    const type = out.headers['Content-Type'] || 'application/json';
    return new Response(out.body, { status: out.status, headers: { 'Content-Type': type, ...(out.headers['Content-Disposition'] ? { 'Content-Disposition': out.headers['Content-Disposition'] } : {}) } });
  }
  window.LOCAL_API = localApi;

  // ---------- Public data published weekly by the GitHub workflow ----------
  let published = { links: {} };
  try {
    published = JSON.parse(local('bop.published') || '{"links":{}}');
  } catch {}

  async function getUpdates() {
    const [dir, leads] = await Promise.all([
      fetch(`data/directory.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`data/leads.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const result = { directory: null, leads: null };
    if (dir?.resources?.length) {
      const db = BOP_ENGINE.require('/server/db');
      result.directory = db.mergeResources(app.db, dir.resources, { updateExisting: true, source: 'seed' });
      published.links = Object.fromEntries(dir.resources.filter((r) => r.website && r.link_status).map((r) => [r.website, r.link_status]));
      published.directoryAt = dir.generated_at;
    }
    if (leads?.leads) {
      result.leads = app.discovery.importLeads(leads.leads);
      published.sources = leads.sources || [];
      published.leadsAt = leads.generated_at;
    }
    local('bop.published', JSON.stringify(published));
    local('bop.updated', String(Date.now()));
    await persist();
    return result;
  }

  // Website checks can't run from a phone browser (other sites block it), so
  // "Check websites" reports what the weekly GitHub check found.
  async function publishedLinkFetch(url) {
    const s = published.links[url];
    if (!s) throw new Error('not checked yet');
    if (s === 'ok') return { ok: true, status: 200 };
    const code = Number((s.match(/\((\d+)\)/) || [])[1]);
    if (code) return { ok: false, status: code };
    throw new Error(s);
  }

  // Discovery runs on GitHub (it needs to download large public files); on the
  // phone, "Run" pulls the latest published results.
  function adaptDiscovery(d) {
    d.listSources = () =>
      (published.sources || []).map((s) => ({ ...s, enabled: true, last_status: s.last_status || 'waiting for first weekly run' }));
    d.runAll = async () => {
      const r = await getUpdates();
      return [{ id: 'published', status: r.leads ? 'ok · updated from weekly public-records run' : 'error · no published results yet', found: r.leads?.added ?? 0 }];
    };
    d.runSource = async () => (await d.runAll())[0];
    d.addWebpageSource = () => {
      const err = new Error('On the phone app, add pages to data/discovery-pages.json in the GitHub repository; the weekly run will read them.');
      err.status = 400;
      throw err;
    };
    d.setSourceEnabled = () => true;
    d.deleteSource = () => false;
  }

  // ---------- Page additions ----------
  // Downloads (CSV/JSON exports) open as files instead of navigating away.
  document.addEventListener('click', async (e) => {
    const a = e.target.closest && e.target.closest('a[href*="api/"]');
    if (!a) return;
    e.preventDefault();
    const res = await localApi(a.getAttribute('href').replace(/^.*?(\/api\/)/, '$1'));
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'export.txt';
    saveFile(await res.blob(), name);
  });

  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // A "This phone" panel on the staff page: updates, backup, restore.
  async function devicePanel() {
    await ready;
    const main = document.querySelector('main');
    if (!main || !document.getElementById('app')) return;
    const login = document.getElementById('login');
    if (login && !localStorage.getItem('bop.passcode')) {
      const p = document.createElement('p');
      p.className = 'notice';
      p.textContent = 'First time on this phone: choose a passcode (4+ characters). You’ll use it to open the staff side. It can’t be recovered, so keep a backup.';
      login.querySelector('h1').after(p);
    }
    const card = document.createElement('section');
    card.className = 'card no-print';
    card.id = 'device';
    const msg = document.createElement('p');
    msg.className = 'small muted';
    const btn = (label, fn, cls = 'btn secondary small') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (err) {
          msg.textContent = err.message;
        } finally {
          b.disabled = false;
        }
      });
      return b;
    };
    const fileIn = document.createElement('input');
    fileIn.type = 'file';
    fileIn.accept = '.sqlite,.db,application/octet-stream';
    fileIn.className = 'hidden';
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f || !confirm('Replace everything on this phone with this backup?')) return;
      await saveBytes(new Uint8Array(await f.arrayBuffer()));
      location.reload();
    });
    const status = () => {
      const when = (t) => (t ? new Date(t).toLocaleDateString() : 'not yet');
      msg.textContent = `Data stays on this phone. Directory updated: ${when(published.directoryAt)} · public-records leads: ${when(published.leadsAt)}.`;
    };
    status();
    const h = document.createElement('h3');
    h.textContent = 'This phone';
    const row = document.createElement('div');
    row.className = 'chips';
    row.append(
      btn('↻ Get latest directory & leads', async () => {
        if (!navigator.onLine) throw new Error('You’re offline — try again with a connection.');
        const r = await getUpdates();
        status();
        msg.textContent += r.directory ? ` ${r.directory.added} new programs, ${r.directory.updated} updated.` : ' No published directory yet.';
      }),
      btn('Back up (save file)', async () => {
        await persist();
        saveFile(new Blob([globalThis.__BOP.db.export()], { type: 'application/octet-stream' }), `bridge-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
        local('bop.backedUp', String(Date.now()));
        msg.textContent = 'Backup saved. Keep it somewhere safe (Files, iCloud Drive) — it contains youth records.';
      }),
      btn('Restore from backup', async () => fileIn.click()),
      fileIn
    );
    const tip = document.createElement('p');
    tip.className = 'hint';
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    tip.textContent = standalone
      ? 'Back up regularly — if this app is deleted, its data goes with it.'
      : 'Tip: in Safari tap Share → “Add to Home Screen”. iPhone can clear data for websites you haven’t opened in a while; the Home Screen app keeps it.';
    card.append(h, msg, row, tip);
    main.append(card);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', devicePanel);
  else devicePanel();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
