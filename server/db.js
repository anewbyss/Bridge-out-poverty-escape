'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SEED_FILE = path.join(__dirname, '..', 'data', 'resources.seed.json');

// Columns stored as JSON text. Everything that reads or writes these goes
// through toRow/fromRow so callers only ever see arrays.
const RESOURCE_JSON = ['categories', 'populations', 'requires', 'counties', 'languages', 'culturally_specific', 'flags'];
const CLIENT_JSON = ['race', 'gender', 'family', 'income_sources', 'vulnerabilities', 'needs', 'preferences', 'tags', 'household', 'documents'];

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org TEXT,
  description TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  populations TEXT NOT NULL DEFAULT '[]',
  requires TEXT NOT NULL DEFAULT '[]',
  counties TEXT NOT NULL DEFAULT '[]',
  languages TEXT NOT NULL DEFAULT '["en"]',
  culturally_specific TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  age_min INTEGER NOT NULL DEFAULT 9,
  age_max INTEGER NOT NULL DEFAULT 26,
  phone TEXT,
  text TEXT,
  website TEXT,
  address TEXT,
  hours TEXT,
  eligibility TEXT,
  crisis INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  last_verified TEXT,
  verified_by TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',
  link_status TEXT,
  link_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'self',
  age INTEGER,
  confidential INTEGER NOT NULL DEFAULT 0,
  county TEXT,
  zip TEXT,
  race TEXT NOT NULL DEFAULT '[]',
  sex TEXT,
  gender TEXT NOT NULL DEFAULT '[]',
  lgbtq TEXT,
  family TEXT NOT NULL DEFAULT '[]',
  household_size INTEGER,
  income TEXT,
  income_sources TEXT NOT NULL DEFAULT '[]',
  housing TEXT,
  education TEXT,
  employment TEXT,
  vulnerabilities TEXT NOT NULL DEFAULT '[]',
  needs TEXT NOT NULL DEFAULT '[]',
  preferences TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  contact_ok INTEGER NOT NULL DEFAULT 0,
  contact_method TEXT,
  contact_value TEXT
);

CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  needs TEXT NOT NULL DEFAULT '[]',
  unmet_needs TEXT NOT NULL DEFAULT '[]',
  match_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  need TEXT,
  score REAL NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'suggested',
  barriers TEXT NOT NULL DEFAULT '[]',
  validated_at TEXT,
  validated_by TEXT,
  validation_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outcome_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id INTEGER NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  barriers TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  reported_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_referrals_client ON referrals(client_id);
CREATE INDEX IF NOT EXISTS idx_referrals_resource ON referrals(resource_id);
CREATE INDEX IF NOT EXISTS idx_searches_client ON searches(client_id);
CREATE INDEX IF NOT EXISTS idx_events_referral ON outcome_events(referral_id);
`;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fromRow(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const col of jsonCols) if (col in out) out[col] = parseJson(out[col], col === 'household' ? {} : []);
  return out;
}

function resourceFromRow(row) {
  const r = fromRow(row, RESOURCE_JSON);
  if (r) {
    r.crisis = !!r.crisis;
    r.active = !!r.active;
    r.edited = !!r.edited;
  }
  return r;
}

function normalizeResource(input) {
  const arr = (v) => (Array.isArray(v) ? v.map(String) : []);
  const str = (v) => (v == null || v === '' ? null : String(v).trim());
  const int = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    id: str(input.id),
    name: str(input.name),
    org: str(input.org),
    description: str(input.description),
    categories: arr(input.categories),
    populations: arr(input.populations),
    requires: arr(input.requires),
    counties: arr(input.counties),
    languages: input.languages ? arr(input.languages) : ['en'],
    culturally_specific: arr(input.culturally_specific),
    flags: arr(input.flags),
    age_min: int(input.age_min, 9),
    age_max: int(input.age_max, 26),
    phone: str(input.phone),
    text: str(input.text),
    website: str(input.website),
    address: str(input.address),
    hours: str(input.hours),
    eligibility: str(input.eligibility),
    crisis: input.crisis ? 1 : 0,
    active: input.active === false || input.active === 0 ? 0 : 1,
    last_verified: str(input.last_verified),
    verified_by: str(input.verified_by),
  };
}

// Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves
// older databases alone, so add anything missing here.
const ADDED_COLUMNS = {
  resources: {
    edited: 'INTEGER NOT NULL DEFAULT 0',
    source: "TEXT NOT NULL DEFAULT 'seed'",
    link_status: 'TEXT',
    link_checked_at: 'TEXT',
    live_seen_at: 'TEXT',
    live_provider: 'TEXT',
    live_miles: 'REAL',
    page_hash: 'TEXT',
    page_changed_at: 'TEXT',
  },
  clients: {
    confidential: 'INTEGER NOT NULL DEFAULT 0',
    household: "TEXT NOT NULL DEFAULT '{}'",
    documents: "TEXT NOT NULL DEFAULT '[]'",
  },
  referrals: { validated_at: 'TEXT', validated_by: 'TEXT', validation_note: 'TEXT' },
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  // Age became optional. SQLite can't drop NOT NULL in place, so rebuild the
  // table (the documented 12-step recipe, with foreign keys off).
  const age = db.prepare('PRAGMA table_info(clients)').all().find((c) => c.name === 'age');
  if (age && age.notnull) {
    const cols = db.prepare('PRAGMA table_info(clients)').all().map((c) => c.name).join(', ');
    const create = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clients'").get().sql;
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(create.replace(/CREATE TABLE "?clients"?/, 'CREATE TABLE clients_new').replace(/age INTEGER NOT NULL/, 'age INTEGER'));
      db.exec(`INSERT INTO clients_new (${cols}) SELECT ${cols} FROM clients`);
      db.exec('DROP TABLE clients');
      db.exec('ALTER TABLE clients_new RENAME TO clients');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// `extra` sets bookkeeping columns (edited, source) that aren't part of the
// resource's public shape.
function upsertResource(db, input, extra = {}) {
  const r = { ...normalizeResource(input), ...extra };
  const cols = Object.keys(r);
  const values = cols.map((c) => (RESOURCE_JSON.includes(c) ? JSON.stringify(r[c]) : r[c]));
  db.prepare(
    `INSERT INTO resources (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${cols
       .filter((c) => c !== 'id')
       .map((c) => `${c} = excluded.${c}`)
       .join(', ')}, updated_at = datetime('now')`
  ).run(...values);
  return getResource(db, r.id);
}

function getResource(db, id) {
  return resourceFromRow(db.prepare('SELECT * FROM resources WHERE id = ?').get(id));
}

function listResources(db, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM resources ORDER BY name'
    : 'SELECT * FROM resources WHERE active = 1 ORDER BY name';
  return db.prepare(sql).all().map(resourceFromRow);
}

/**
 * Merges a list of resources into the directory.
 * - New ids are always added.
 * - With `updateExisting`, entries staff haven't edited or verified are
 *   refreshed from the list. Staff-edited or verified entries are never touched.
 */
function mergeResources(db, list, { updateExisting = false, source = 'seed' } = {}) {
  const result = { added: 0, updated: 0, kept: 0 };
  const existing = db.prepare('SELECT edited, last_verified FROM resources WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const r of list) {
      const cur = existing.get(r.id);
      if (!cur) {
        upsertResource(db, r, { source, edited: 0 });
        result.added++;
      } else if (updateExisting && !cur.edited && !cur.last_verified) {
        upsertResource(db, r, { source, edited: 0 });
        result.updated++;
      } else result.kept++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function readSeed() {
  return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
}

// Adds any starter programs the database doesn't have yet (on every start),
// without changing existing entries.
function syncSeed(db) {
  return mergeResources(db, readSeed()).added;
}

module.exports = {
  open,
  syncSeed,
  readSeed,
  mergeResources,
  upsertResource,
  getResource,
  listResources,
  normalizeResource,
  fromRow,
  parseJson,
  CLIENT_JSON,
  RESOURCE_JSON,
};
