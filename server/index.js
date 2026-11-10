'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./app');
const { providersFromEnv } = require('./live');
const { mailerFromEnv } = require('./mailer');
const { createVault } = require('./vault');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bridge.db');
const ADMIN_LOGIN = process.env.ADMIN_EMAIL || 'admin';

// STAFF_PASSWORD is only used to create the first "Main architect" account
// in an empty database. After that, everyone signs in with their own account.
let staffPassword = process.env.STAFF_PASSWORD;
let generated = false;
if (!staffPassword) {
  staffPassword = crypto.randomBytes(12).toString('base64url');
  generated = true;
}

const mailer = mailerFromEnv();
const app = createApp({
  dbFile: DB_FILE,
  staffPassword,
  sessionSecret: process.env.SESSION_SECRET,
  secureCookies: process.env.SECURE_COOKIES === '1',
  liveProviders: providersFromEnv(),
  liveOptions: {
    radiusMiles: Number(process.env.ACCESS_RADIUS_MILES) || undefined,
  },
  adminLogin: ADMIN_LOGIN,
  bootstrapMustChange: generated,
  mailer,
  publicUrl: process.env.PUBLIC_URL || null,
  referralEmail: process.env.REFERRAL_EMAIL || null,
  emailDetails: process.env.REFERRAL_EMAIL_DETAILS || null,
  vault: createVault(process.env.DATA_KEY),
  staffAllowedIps: process.env.STAFF_ALLOWED_IPS ? process.env.STAFF_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean) : null,
  trustProxy: process.env.TRUST_PROXY === '1',
});
if (!process.env.DATA_KEY) console.warn('DATA_KEY not set: contact details are stored unencrypted. See SECURITY.md.');
if (process.env.SECURE_COOKIES !== '1') console.warn('SECURE_COOKIES is off: only use this on your own computer, never on the internet without HTTPS.');
if (app.seeded) console.log(`Loaded ${app.seeded} starter resources into ${DB_FILE}`);

if (app.auth.bootstrapped)
  console.warn(
    generated
      ? `Created the main architect account. First sign-in: ${ADMIN_LOGIN} / ${staffPassword}  (you'll be asked to choose a new password)`
      : `Created the main architect account "${ADMIN_LOGIN}" with STAFF_PASSWORD.`
  );
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET not set: staff will be signed out whenever the server restarts.');
console.log(mailer ? `Refer-me emails: on (${mailer.describe()}) → ${app.settings().referral_email}` : 'Refer-me emails: off (set SMTP_HOST, SMTP_USER, SMTP_PASS). Requests are still saved for staff.');

// Data retention: delete expired records once a day (and at start).
const purge = () => {
  try {
    const r = app.purgeExpired();
    if (r.clients || r.requests || r.auditEntries) console.log(`Retention (${r.days} days): removed ${r.clients} youth records, ${r.requests} requests, ${r.auditEntries} log entries`);
  } catch (err) {
    console.error('Retention purge failed', err);
  }
};
purge();
setInterval(purge, 24 * 3600 * 1000).unref();

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

if (process.env.DISCOVERY !== 'off') {
  // Public-records discovery: a minute after start, then every DISCOVERY_DAYS (default 7).
  const days = Number(process.env.DISCOVERY_DAYS) || 7;
  const run = () =>
    app.discovery.runAll().then(
      (r) => console.log(`Discovery: ${r.map((x) => `${x.id} ${x.status} (${x.found ?? 0} new)`).join('; ')}`),
      (err) => console.error('Discovery failed', err)
    );
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, days * 86400 * 1000).unref();
}

http.createServer(app.handle).listen(PORT, () => {
  console.log(`Bridge Out of Poverty running at http://localhost:${PORT}`);
  console.log(`Staff dashboard: http://localhost:${PORT}/staff`);
});
