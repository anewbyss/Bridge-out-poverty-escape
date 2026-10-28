'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SEED_FILE = path.join(__dirname, '..', 'data', 'resources.seed.json');

// Columns stored as JSON text. Everything that reads or writes these goes
// through toRow/fromRow so callers only ever see arrays.
const RESOURCE_JSON = ['categories', 'populations', 'requires', 'counties', 'languages', 'culturally_specific', 'flags'];
const CLIENT_JSON = ['race', 'gender', 'family', 'income_sources', 'vulnerabilities', 'needs', 'preferences', 'tags'];

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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'self',
  age INTEGER NOT NULL,
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
  for (const col of jsonCols) if (col in out) out[col] = parseJson(out[col], []);
  return out;
}

function resourceFromRow(row) {
  const r = fromRow(row, RESOURCE_JSON);
  if (r) {
    r.crisis = !!r.crisis;
    r.active = !!r.active;
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

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function upsertResource(db, input) {
  const r = normalizeResource(input);
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

// Loads the seed directory only into an empty table, so staff edits are never
// overwritten on restart.
function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM resources').get();
  if (n > 0) return 0;
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  db.exec('BEGIN');
  try {
    for (const r of seed) upsertResource(db, r);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return seed.length;
}

module.exports = {
  open,
  seedIfEmpty,
  upsertResource,
  getResource,
  listResources,
  normalizeResource,
  fromRow,
  parseJson,
  CLIENT_JSON,
  RESOURCE_JSON,
};
