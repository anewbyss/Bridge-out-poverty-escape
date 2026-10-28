'use strict';

// Browser stand-ins for the few Node built-ins the server code uses, so the
// same server modules run unchanged on a phone. Bundled by
// scripts/build-mobile.js; `globalThis.__BOP` carries runtime inputs
// (the sql.js module, saved database bytes, the starter directory).

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- SHA-256 (sync; WebCrypto is async-only) ----------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const toBytes = (v) => (typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : enc.encode(String(v)));

const crypto = {
  sha256Hex: (s) => toHex(sha256(toBytes(s))),
  randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    b.toString = (fmt) => (fmt === 'hex' ? toHex(b) : btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    return b;
  },
  // Only sha256 is implemented; other names (sha1, used for ids) map to it.
  createHash() {
    const parts = [];
    return {
      update(v) {
        parts.push(toBytes(v));
        return this;
      },
      digest(fmt) {
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) all.set(p, o), (o += p.length);
        const d = sha256(all);
        return fmt === 'hex' ? toHex(d) : d;
      },
    };
  },
};

// ---------- Buffer (just what readJson needs) ----------
const BufferShim = {
  concat(chunks) {
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) all.set(c, o), (o += c.length);
    all.toString = () => dec.decode(all);
    return all;
  },
  from: (s) => enc.encode(String(s)),
  isBuffer: (v) => v instanceof Uint8Array,
};

// ---------- path / fs ----------
const path = {
  sep: '/',
  join: (...parts) => path.normalize(parts.join('/')),
  normalize(p) {
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '..') out.pop();
      else if (seg && seg !== '.') out.push(seg);
    }
    return `/${out.join('/')}`;
  },
  dirname: (p) => p.replace(/\/[^/]*$/, '') || '/',
  extname: (p) => (p.match(/\.[^./]*$/) || [''])[0],
};

const fs = {
  mkdirSync() {},
  readFileSync(file) {
    if (file.endsWith('resources.seed.json')) return globalThis.__BOP.seedText;
    throw new Error(`No file ${file} on this device`);
  },
  readFile(_file, cb) {
    cb(new Error('Not available on this device'));
  },
};

// ---------- node:sqlite on top of sql.js ----------
// Statements are prepared per call and freed right away: sql.js frees open
// statements when the database is exported for saving.
class DatabaseSync {
  constructor() {
    const { SQL, dbBytes } = globalThis.__BOP;
    this.db = dbBytes ? new SQL.Database(dbBytes) : new SQL.Database();
    globalThis.__BOP.db = this.db;
  }
  exec(sql) {
    this.db.exec(sql);
  }
  prepare(sql) {
    const db = this.db;
    const norm = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
    const withStmt = (args, fn) => {
      const st = db.prepare(sql);
      try {
        if (args.length) st.bind(norm(args));
        return fn(st);
      } finally {
        st.free();
      }
    };
    return {
      get: (...args) => withStmt(args, (st) => (st.step() ? st.getAsObject() : undefined)),
      all: (...args) =>
        withStmt(args, (st) => {
          const rows = [];
          while (st.step()) rows.push(st.getAsObject());
          return rows;
        }),
      run: (...args) => {
        withStmt(args, (st) => st.step());
        const changes = db.getRowsModified();
        const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid: id };
      },
    };
  }
  close() {}
}

module.exports = {
  crypto,
  fs,
  path,
  sqlite: { DatabaseSync },
  Buffer: BufferShim,
  readline: { createInterface() { throw new Error('Not available on this device'); } },
  stream: { Readable: { fromWeb() { throw new Error('Not available on this device'); } } },
  sha256Hex: crypto.sha256Hex,
};
