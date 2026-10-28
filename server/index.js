'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./app');
const { providersFromEnv } = require('./live');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bridge.db');

let staffPassword = process.env.STAFF_PASSWORD;
if (!staffPassword) {
  staffPassword = crypto.randomBytes(9).toString('base64url');
  console.warn(`STAFF_PASSWORD not set — using a temporary password for this run: ${staffPassword}`);
}

const app = createApp({
  dbFile: DB_FILE,
  staffPassword,
  sessionSecret: process.env.SESSION_SECRET,
  secureCookies: process.env.SECURE_COOKIES === '1',
  liveProviders: providersFromEnv(),
  liveOptions: {
    radiusMiles: Number(process.env.ACCESS_RADIUS_MILES) || undefined,
  },
});
if (app.seeded) console.log(`Loaded ${app.seeded} starter resources into ${DB_FILE}`);

if (app.live.enabled) {
  // Full refresh at start and every LIVE_SYNC_HOURS (default 12).
  const hours = Number(process.env.LIVE_SYNC_HOURS) || 12;
  const sync = () =>
    app.live.syncAll().then(
      (s) => console.log(`Live sync: ${s.fetched} lookups, ${s.kept} listings kept, ${s.errors.length} errors`),
      (err) => console.error('Live sync failed', err)
    );
  sync();
  setInterval(sync, hours * 3600 * 1000).unref();
} else {
  console.log('Live lookup is off (set HSDS_API_URL or NDP_SEARCH_URL + NDP_API_KEY to turn it on).');
}

http.createServer(app.handle).listen(PORT, () => {
  console.log(`Bridge Out of Poverty running at http://localhost:${PORT}`);
  console.log(`Staff dashboard: http://localhost:${PORT}/staff`);
});
