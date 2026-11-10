'use strict';

// Staff accounts and sign-in.
//
// - Each person has their own account (email + password) and a role
//   (server/roles.js). No shared passwords.
// - Passwords are hashed with scrypt and a per-user salt.
// - Optional two-step sign-in with any authenticator app (TOTP, RFC 6238).
//   Architects can require it for everyone.
// - Sessions are signed cookies that carry the user's id and a
//   "session version". Changing a password, disabling an account or
//   "sign out everywhere" bumps the version, which ends every old session.
// - 5 wrong passwords lock the account (and the IP) for 15 minutes.
//
// On first start with an empty database, a "Main architect" account is
// created from STAFF_PASSWORD (login: ADMIN_EMAIL, default "admin").
// The phone app replaces this file with mobile/auth.js.

const crypto = require('node:crypto');
const { ROLE_IDS, canManageRole, permissionsFor } = require('./roles');

const COOKIE = 'bop_staff';
const SECURE_COOKIE = '__Host-bop_staff'; // browser enforces Secure, Path=/, no Domain
const TTL_MS = 8 * 60 * 60 * 1000; // absolute session length
const IDLE_MS = 30 * 60 * 1000; // signed out after 30 minutes without activity
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILS = 5; // per account from one IP
const MAX_IP_FAILS = 15; // per IP across all accounts
const MAX_ACCOUNT_FAILS = 50; // per account from everywhere (credential stuffing)
const MIN_PASSWORD = 12;
const PRIVILEGED = new Set(['architect', 'maintainer']);

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// ---------- Passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkHash(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}

function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (/^(.)\1+$/.test(s) || new Set(s).size < 5) return 'That password is too simple.';
  const lower = s.toLowerCase();
  if (/(password|qwerty|123456|letmein|bridge|poverty|admin|welcome|portland)/.test(lower) && s.length < 20)
    return 'Avoid common words like “password”, “admin” or the program’s name — try a long phrase of 4+ random words.';
  return null;
}

// Readable temporary password for resets: 4 groups of 4.
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += abc[b[i] % abc.length] + (i % 4 === 3 && i < 15 ? '-' : '');
  return out;
}

// ---------- TOTP (authenticator apps) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Returns the matching time step (to block reuse), or null.
function totpStep(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if (hotp(secret, step + d) === c) return step + d;
  return null;
}

// ---------- Accounts ----------
const PUBLIC_COLS = 'id, email, name, role, programs, must_change_password, totp_enabled, active, last_login_at, created_at, updated_at';

function rowToUser(row) {
  if (!row) return null;
  let programs = [];
  try {
    programs = JSON.parse(row.programs || '[]');
  } catch {}
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    programs,
    must_change_password: !!row.must_change_password,
    totp_enabled: !!row.totp_enabled,
    active: !!row.active,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function createAuth({ db, password, secret, adminLogin = 'admin', bootstrapMustChange = false, enforceAdmin2fa = true, secureCookies = false }) {
  const key = secret || crypto.randomBytes(32).toString('hex');
  const cookieName = secureCookies ? SECURE_COOKIE : COOKIE;
  const ipFails = new Map(); // ip -> { count, until }
  const pairFails = new Map(); // `${userId}|${ip}` -> { count, until }
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const getRow = (id) => db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id);
  const getByEmail = (email) => db.prepare('SELECT * FROM staff_users WHERE email = ?').get(normEmail(email));

  // First run: create the main architect account.
  const count = db.prepare('SELECT COUNT(*) AS n FROM staff_users').get().n;
  const bootstrapped = !count && !!password;
  if (bootstrapped) {
    db.prepare(
      'INSERT INTO staff_users (email, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?)'
    ).run(normEmail(adminLogin) || 'admin', 'Main architect', 'architect', hashPassword(password), bootstrapMustChange ? 1 : 0);
  }

  const requireTotp = () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'require_2fa'").get();
    return row ? row.value === 'true' : false;
  };

  // ---------- Sign in ----------
  // body: { email (or login), password, code }. If `email` is left out the
  // bootstrap login ("admin") is assumed, so a one-person setup still works
  // with just the password.
  //
  // Lockouts are layered so an attacker can't lock real staff out just by
  // typing their email wrong on purpose from somewhere else:
  //   - 5 misses for one account from one IP → that IP is locked out of that account
  //   - 15 misses from one IP (any accounts) → that IP is locked out
  //   - 50 misses on one account from anywhere → account locked 15 minutes
  function login(body, ip) {
    const now = Date.now();
    const bump = (map, k, max) => {
      const cur = map.get(k);
      const n = (cur && cur.until && cur.until <= now ? 0 : cur?.count || 0) + 1;
      map.set(k, { count: n, until: n >= max ? now + LOCK_MS : 0 });
      if (map.size > 10000) map.clear();
      return n >= max;
    };
    const blocked = (map, k) => (map.get(k)?.until || 0) > now;
    if (blocked(ipFails, ip)) return { ok: false, locked: true };

    const row = getByEmail(body.email || body.login || adminLogin);
    if (!row || !row.active) {
      // Spend the same time as a real check so accounts can't be probed.
      checkHash(String(body.password || ''), 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      return { ok: false, locked: bump(ipFails, ip, MAX_IP_FAILS) };
    }
    const pair = `${row.id}|${ip}`;
    if (blocked(pairFails, pair)) return { ok: false, locked: true, user: rowToUser(row) };
    if (row.locked_until && Date.parse(`${row.locked_until}Z`) > now) return { ok: false, locked: true, user: rowToUser(row) };
    const fail = (extra = {}) => {
      const n = row.failed_logins + 1;
      db.prepare(
        "UPDATE staff_users SET failed_logins = ?, locked_until = CASE WHEN ? >= ? THEN datetime('now', '+15 minutes') ELSE locked_until END WHERE id = ?"
      ).run(n >= MAX_ACCOUNT_FAILS ? 0 : n, n, MAX_ACCOUNT_FAILS, row.id);
      const locked = bump(pairFails, pair, MAX_FAILS) | bump(ipFails, ip, MAX_IP_FAILS);
      return { ok: false, user: rowToUser(row), locked: !!locked, accountLocked: n >= MAX_ACCOUNT_FAILS, ...extra };
    };
    if (!checkHash(String(body.password || ''), row.password_hash)) return fail();
    if (row.totp_enabled) {
      if (!body.code) return { ok: false, needCode: true };
      const step = totpStep(row.totp_secret, body.code, now);
      if (step == null || (row.totp_last_step != null && step <= row.totp_last_step)) return fail({ needCode: true, badCode: true });
      db.prepare('UPDATE staff_users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
    }
    ipFails.delete(ip);
    pairFails.delete(pair);
    db.prepare("UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(row.id);
    return { ok: true, user: rowToUser(getRow(row.id)) };
  }

  // ---------- Sessions ----------
  // Token: id.version.issuedAt.lastActive.signature. The absolute limit runs
  // from issuedAt; the idle limit from lastActive, which slides forward as
  // the person keeps using the app (see refreshCookie).
  function issue(user, issuedAt = Date.now()) {
    const row = getRow(user.id);
    const payload = `${row.id}.${row.session_version}.${issuedAt}.${Date.now()}`;
    return `${payload}.${sign(payload)}`;
  }

  function parse(token) {
    if (!token) return null;
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i);
    const sig = Buffer.from(token.slice(i + 1));
    const good = Buffer.from(sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    const [id, ver, iat, active] = payload.split('.').map(Number);
    const now = Date.now();
    if (!(iat + TTL_MS > now) || !(active + IDLE_MS > now)) return null;
    return { id, ver, iat, active };
  }

  function verify(token) {
    const t = parse(token);
    if (!t) return null;
    const row = getRow(t.id);
    if (!row || !row.active || row.session_version !== t.ver) return null;
    const user = rowToUser(row);
    user.permissions = permissionsFor(user.role);
    user.needs_2fa_setup = !user.totp_enabled && (requireTotp() || (enforceAdmin2fa && PRIVILEGED.has(user.role)));
    Object.defineProperty(user, '_session', { value: t, enumerable: false });
    return user;
  }

  function cookieHeader(token, secure = secureCookies) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${token ? TTL_MS / 1000 : 0}`];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  // New cookie with lastActive = now, sent at most once a minute.
  function refreshCookie(user) {
    const s = user && user._session;
    if (!s || Date.now() - s.active < 60 * 1000) return null;
    return cookieHeader(issue(user, s.iat));
  }

  function fromRequest(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return verify(v.join('='));
    }
    return null;
  }

  // ---------- Account management ----------
  function listUsers() {
    return db.prepare(`SELECT ${PUBLIC_COLS} FROM staff_users ORDER BY active DESC, role, name`).all().map(rowToUser);
  }

  function cleanPrograms(list) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw new AuthError(400, 'Programs must be a list');
    const exists = db.prepare('SELECT 1 FROM resources WHERE id = ?');
    const bad = list.filter((id) => !exists.get(String(id)));
    if (bad.length) throw new AuthError(400, `Unknown program: ${bad.join(', ')}`);
    return [...new Set(list.map(String))];
  }

  function createUser(actor, body) {
    const email = normEmail(body.email);
    const name = String(body.name || '').trim().slice(0, 100);
    const role = String(body.role || '');
    if (!isEmail(email)) throw new AuthError(400, 'Enter a valid email address');
    if (!name) throw new AuthError(400, 'Enter the person’s name');
    if (!ROLE_IDS.has(role)) throw new AuthError(400, 'Choose a role');
    if (!canManageRole(actor, role)) throw new AuthError(403, 'You can’t create an account with that role');
    if (getByEmail(email)) throw new AuthError(409, 'An account with that email already exists');
    const programs = cleanPrograms(body.programs);
    if (role === 'program_partner' && !programs.length) throw new AuthError(400, 'Pick at least one program this person manages');
    const temp = tempPassword();
    const r = db.prepare(
      'INSERT INTO staff_users (email, name, role, programs, password_hash, must_change_password, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)'
    ).run(email, name, role, JSON.stringify(programs), hashPassword(temp), actor.id);
    return { user: rowToUser(getRow(Number(r.lastInsertRowid))), tempPassword: temp };
  }

  function updateUser(actor, id, body) {
    const row = getRow(Number(id));
    if (!row) throw new AuthError(404, 'Account not found');
    if (!canManageRole(actor, row.role)) throw new AuthError(403, 'You can’t change this account');
    const role = body.role == null ? row.role : String(body.role);
    if (!ROLE_IDS.has(role)) throw new AuthError(400, 'Choose a role');
    if (!canManageRole(actor, role)) throw new AuthError(403, 'You can’t give that role');
    const active = body.active == null ? !!row.active : body.active === true;
    if (row.id === actor.id && (!active || role !== row.role)) throw new AuthError(400, 'You can’t change your own role or disable yourself');
    if (row.role === 'architect' && (role !== 'architect' || !active)) {
      const others = db.prepare("SELECT COUNT(*) AS n FROM staff_users WHERE role = 'architect' AND active = 1 AND id != ?").get(row.id).n;
      if (!others) throw new AuthError(400, 'Keep at least one active main architect');
    }
    const name = body.name == null ? row.name : String(body.name).trim().slice(0, 100) || row.name;
    const programs = body.programs == null ? JSON.parse(row.programs || '[]') : cleanPrograms(body.programs);
    if (role === 'program_partner' && !programs.length) throw new AuthError(400, 'Pick at least one program this person manages');
    const bump = role !== row.role || active !== !!row.active ? 1 : 0;
    db.prepare(
      `UPDATE staff_users SET name = ?, role = ?, programs = ?, active = ?, session_version = session_version + ?,
       updated_at = datetime('now') WHERE id = ?`
    ).run(name, role, JSON.stringify(programs), active ? 1 : 0, bump, row.id);
    return rowToUser(getRow(row.id));
  }

  function resetPassword(actor, id) {
    const row = getRow(Number(id));
    if (!row) throw new AuthError(404, 'Account not found');
    if (!canManageRole(actor, row.role)) throw new AuthError(403, 'You can’t reset this account');
    const temp = tempPassword();
    db.prepare(
      `UPDATE staff_users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL,
       session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?`
    ).run(hashPassword(temp), row.id);
    return { tempPassword: temp };
  }

  // Turns off two-step sign-in for someone who lost their phone.
  function resetTotp(actor, id) {
    const row = getRow(Number(id));
    if (!row) throw new AuthError(404, 'Account not found');
    if (!canManageRole(actor, row.role)) throw new AuthError(403, 'You can’t change this account');
    db.prepare("UPDATE staff_users SET totp_enabled = 0, totp_secret = NULL, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?").run(row.id);
  }

  function changeOwnPassword(user, current, next) {
    const row = getRow(user.id);
    if (!checkHash(String(current || ''), row.password_hash)) throw new AuthError(400, 'Your current password is wrong');
    const problem = passwordProblem(next);
    if (problem) throw new AuthError(400, problem);
    if (checkHash(String(next), row.password_hash)) throw new AuthError(400, 'Choose a new password, not the current one');
    db.prepare(
      "UPDATE staff_users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?"
    ).run(hashPassword(next), row.id);
    return rowToUser(getRow(row.id));
  }

  function totpBegin(user) {
    // A stolen session must not be able to swap in the attacker's own phone.
    if (getRow(user.id).totp_enabled) throw new AuthError(400, 'Two-step sign-in is already on. Turn it off with your password first.');
    const secretB32 = base32(crypto.randomBytes(20));
    db.prepare('UPDATE staff_users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secretB32, user.id);
    const label = encodeURIComponent(`Bridge Out of Poverty:${user.email}`);
    return { secret: secretB32, otpauth: `otpauth://totp/${label}?secret=${secretB32}&issuer=Bridge%20Out%20of%20Poverty&digits=6&period=30` };
  }

  function totpEnable(user, code) {
    const row = getRow(user.id);
    if (!row.totp_secret) throw new AuthError(400, 'Start setup first');
    const step = totpStep(row.totp_secret, code);
    if (step == null) throw new AuthError(400, 'That code didn’t match. Check your phone’s clock and try the newest code.');
    db.prepare("UPDATE staff_users SET totp_enabled = 1, totp_last_step = ?, updated_at = datetime('now') WHERE id = ?").run(step, row.id);
  }

  function totpDisable(user, pw) {
    const row = getRow(user.id);
    if (!checkHash(String(pw || ''), row.password_hash)) throw new AuthError(400, 'Your password is wrong');
    if (requireTotp()) throw new AuthError(400, 'Two-step sign-in is required for all staff here');
    if (enforceAdmin2fa && PRIVILEGED.has(row.role)) throw new AuthError(400, 'Architect and maintenance accounts must keep two-step sign-in on');
    db.prepare("UPDATE staff_users SET totp_enabled = 0, totp_secret = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
  }

  function logoutEverywhere(user) {
    db.prepare('UPDATE staff_users SET session_version = session_version + 1 WHERE id = ?').run(user.id);
  }

  return {
    login,
    issue,
    verify,
    cookieHeader,
    refreshCookie,
    fromRequest,
    listUsers,
    createUser,
    updateUser,
    resetPassword,
    resetTotp,
    changeOwnPassword,
    totpBegin,
    totpEnable,
    totpDisable,
    logoutEverywhere,
    multiUser: true,
    bootstrapped,
  };
}

module.exports = { createAuth, AuthError, hashPassword, checkHash, hotp, totpStep, base32, passwordProblem };
