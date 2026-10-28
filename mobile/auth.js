'use strict';

// Phone version of server/auth.js. The staff password becomes a device
// passcode: the first one entered is saved (hashed) on the phone, and a
// session lasts until the app is closed.

const { sha256Hex } = require('./shims');

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

function createAuth() {
  const failures = { count: 0, until: 0 };
  const salted = (p) => sha256Hex(`bop-device:${p}`);

  return {
    hasPasscode: () => !!store.get(KEY),
    checkPassword(attempt) {
      if (failures.until > Date.now()) return { ok: false, locked: true };
      const saved = store.get(KEY);
      if (!saved) {
        if (String(attempt).length < 4) return { ok: false };
        store.set(KEY, salted(attempt));
        return { ok: true, created: true };
      }
      const ok = salted(attempt) === saved;
      if (ok) failures.count = 0;
      else if (++failures.count >= 5) failures.until = Date.now() + 5 * 60 * 1000;
      return { ok };
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
    fromRequest() {
      return !!store.get(SESSION, sessionStorage);
    },
    verify() {
      return !!store.get(SESSION, sessionStorage);
    },
  };
}

module.exports = { createAuth };
