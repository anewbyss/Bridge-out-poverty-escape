'use strict';

// Field-level encryption for the most sensitive things we store (how to reach
// a young person, their name and notes in Refer-me requests). If someone
// copies the database file, these stay unreadable without DATA_KEY.
//
// DATA_KEY: 32 random bytes as 64 hex characters, e.g.
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Keep it OUT of the database folder and out of backups of that folder.
// Losing the key means losing those fields; rotating it needs a re-encrypt.
//
// Server only. The phone app keeps data on the device and uses an identity vault.

const crypto = require('node:crypto');

const PREFIX = 'enc1:';

function createVault(hexKey) {
  if (!hexKey) return identityVault();
  const key = Buffer.from(String(hexKey).trim(), 'hex');
  if (key.length !== 32) throw new Error('DATA_KEY must be 64 hex characters (32 bytes)');
  return {
    enabled: true,
    seal(value) {
      if (value == null || value === '') return value;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    open(value) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
      try {
        const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
        const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      } catch {
        return '[cannot decrypt — wrong DATA_KEY]';
      }
    },
  };
}

function identityVault() {
  return { enabled: false, seal: (v) => v, open: (v) => v };
}

module.exports = { createVault, identityVault };
