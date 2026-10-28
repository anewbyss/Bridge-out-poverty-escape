'use strict';

const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('./app');

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
});
if (app.seeded) console.log(`Loaded ${app.seeded} starter resources into ${DB_FILE}`);

http.createServer(app.handle).listen(PORT, () => {
  console.log(`Bridge Out of Poverty running at http://localhost:${PORT}`);
  console.log(`Staff dashboard: http://localhost:${PORT}/staff`);
});
