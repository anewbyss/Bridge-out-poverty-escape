'use strict';

// Phone version of server/auth.js. The phone belongs to one staff member, so
// instead of accounts there is a device passcode: the first one entered is
// saved (hashed) on the phone, and a session lasts until the app is closed.
// The signed-in "user" is the phone's owner with the main-architect role.
// Multi-person accounts need the server version.

const { sha256Hex } = require('./shims');
const { permissionsFor } = require('../server/roles');

const KEY = 'bop.passcode';
const SESSION = 'bop.session';
const store = {
  get: (k, s = localStorage) => {
    try {
      return s.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v, s = localStorage) => {
    try {
      s.setItem(k, v);
    } catch {}
  },
  del: (k, s = localStorage) => {
    try {
      s.removeItem(k);
    } catch {}
  },
};

const DEVICE_USER = Object.freeze({
  id: 0,
  email: 'this-phone',
  name: 'This phone',
  role: 'architect',
  programs: [],
  must_change_password: false,
  totp_enabled: false,
  active: true,
});

function notOnPhone() {
  const err = new Error('Staff accounts need the server version of the app. On the phone app, one passcode protects the staff side.');
  err.status = 400;
  err.expose = true;
  throw err;
}

function createAuth() {
  const failures = { count: 0, until: 0 };
  const salted = (p) => sha256Hex(`bop-device:${p}`);
  const user = () => ({ ...DEVICE_USER, permissions: permissionsFor('architect'), needs_2fa_setup: false });
  const signedIn = () => !!store.get(SESSION, sessionStorage);

  return {
    multiUser: false,
    hasPasscode: () => !!store.get(KEY),
    login({ password }) {
      if (failures.until > Date.now()) return { ok: false, locked: true };
      const saved = store.get(KEY);
      if (!saved) {
        if (String(password || '').length < 4) return { ok: false };
        store.set(KEY, salted(password));
        return { ok: true, user: user(), created: true };
      }
      const ok = salted(password) === saved;
      if (ok) failures.count = 0;
      else if (++failures.count >= 5) failures.until = Date.now() + 5 * 60 * 1000;
      return ok ? { ok, user: user() } : { ok };
    },
    issue() {
      const token = sha256Hex(`${Math.random()}${Date.now()}`);
      store.set(SESSION, token, sessionStorage);
      return token;
    },
    cookieHeader(token) {
      if (!token) store.del(SESSION, sessionStorage);
      return 'bop=local';
    },
    refreshCookie: () => null,
    fromRequest: () => (signedIn() ? user() : null),
    verify: () => (signedIn() ? user() : null),
    listUsers: () => [user()],
    createUser: notOnPhone,
    updateUser: notOnPhone,
    resetPassword: notOnPhone,
    resetTotp: notOnPhone,
    changeOwnPassword: notOnPhone,
    totpBegin: notOnPhone,
    totpEnable: notOnPhone,
    totpDisable: notOnPhone,
    logoutEverywhere() {
      store.del(SESSION, sessionStorage);
    },
  };
}

module.exports = { createAuth };
