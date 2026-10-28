'use strict';

const crypto = require('node:crypto');

const COOKIE = 'bop_staff';
const TTL_MS = 8 * 60 * 60 * 1000;

function createAuth({ password, secret }) {
  const key = secret || crypto.randomBytes(32).toString('hex');
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const expected = digest(password);
  const failures = new Map(); // ip -> { count, until }

  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function checkPassword(attempt, ip) {
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return { ok: false, locked: true };
    const ok = crypto.timingSafeEqual(digest(attempt), expected);
    if (ok) failures.delete(ip);
    else {
      const count = (f?.count || 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    }
    return { ok };
  }

  function issue() {
    const payload = `staff.${Date.now() + TTL_MS}`;
    return `${payload}.${sign(payload)}`;
  }

  function verify(token) {
    if (!token) return false;
    const i = token.lastIndexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
    return Number(payload.split('.')[1]) > Date.now();
  }

  function cookieHeader(token, secure) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? TTL_MS / 1000 : 0}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function fromRequest(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return verify(v.join('='));
    }
    return false;
  }

  return { checkPassword, issue, verify, cookieHeader, fromRequest };
}

module.exports = { createAuth };
