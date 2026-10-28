'use strict';

// Weekly public-data run for the phone app (GitHub Actions). Runs discovery
// (federal grants, IRS registry, watched pages) and website checks, then
// writes build/directory.json and build/leads.json for scripts/build-mobile.js.
// Contains only public information — never youth data.
// Usage: node scripts/publish-data.js

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const store = require('../server/store');
const { listResources } = require('../server/db');

const OUT = path.join(__dirname, '..', 'build');
const PAGES_FILE = path.join(__dirname, '..', 'data', 'discovery-pages.json');

async function main() {
  const app = createApp({ dbFile: ':memory:', staffPassword: 'unused' });

  // Extra public pages to watch (county listings, coalition member lists).
  if (fs.existsSync(PAGES_FILE)) {
    for (const p of JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8'))) app.discovery.addWebpageSource(p);
  }

  const runs = await app.discovery.runAll();
  for (const r of runs) console.log(`discovery ${r.id}: ${r.status} (${r.found ?? 0} records)`);
  const links = await store.checkLinks(app.db);
  console.log(`websites: ${links.ok}/${links.checked} loaded, ${links.broken.length} need a look`);

  const generated_at = new Date().toISOString();
  const resources = listResources(app.db).map(({ page_hash, ...r }) => r);
  const { leads } = app.discovery.listLeads({ status: 'all', limit: 1000 });
  const sources = app.discovery.listSources().map(({ id, name, url, kind, last_run_at, last_status, last_found }) => ({
    id, name, url, kind, last_run_at, last_status, last_found,
  }));

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'directory.json'), JSON.stringify({ generated_at, resources }));
  fs.writeFileSync(
    path.join(OUT, 'leads.json'),
    JSON.stringify({ generated_at, sources, leads: leads.filter((l) => l.status === 'new' || l.status === 'known') })
  );
  console.log(`wrote ${resources.length} programs and ${leads.length} leads to ${OUT}`);
}

main().catch((err) => {
  // Never fail the deploy over a public source being down; the app still
  // ships with the starter directory.
  console.error('publish-data failed:', err);
});
