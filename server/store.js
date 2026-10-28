'use strict';

const crypto = require('node:crypto');
const T = require('./taxonomy');
const { match, deriveTags } = require('./matcher');
const { listResources, fromRow, parseJson, CLIENT_JSON } = require('./db');

const FINAL = new Set(T.OUTCOMES.filter((o) => o.final).map((o) => o.id));
const SUCCESS = new Set(T.OUTCOMES.filter((o) => o.success).map((o) => o.id));
// Unambiguous characters only (no 0/O, 1/I/L) so codes are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRefCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(code) {
  const c = String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Outcome history per resource, fed back into the matcher's scoring.
function resourceStats(db) {
  const rows = db.prepare("SELECT resource_id, status, barriers, validated_at FROM referrals WHERE status != 'suggested'").all();
  const stats = {};
  for (const r of rows) {
    const s = (stats[r.resource_id] ||= { referrals: 0, finals: 0, successes: 0, validated: 0, barriers: {} });
    s.referrals++;
    if (r.validated_at) s.validated++;
    if (FINAL.has(r.status)) s.finals++;
    if (SUCCESS.has(r.status)) s.successes++;
    for (const b of parseJson(r.barriers, [])) s.barriers[b] = (s.barriers[b] || 0) + 1;
  }
  return stats;
}

function runSearch(db, clientId, profile) {
  const results = match(profile, listResources(db), resourceStats(db));
  const search = db
    .prepare('INSERT INTO searches (client_id, needs, unmet_needs, match_count) VALUES (?, ?, ?, ?)')
    .run(
      clientId,
      JSON.stringify(results.needs),
      JSON.stringify(results.unmetNeeds),
      results.byNeed.reduce((n, g) => n + g.matches.length, 0)
    );
  const searchId = Number(search.lastInsertRowid);

  // One referral per resource, filed under the first need it was shown for.
  const insert = db.prepare(
    'INSERT INTO referrals (client_id, search_id, resource_id, need, score, rank) VALUES (?, ?, ?, ?, ?, ?)'
  );
  // A refresh reuses earlier referrals to the same program, so the youth's
  // reported outcome stays attached and counts aren't inflated.
  const seen = new Map(
    db.prepare('SELECT resource_id, MIN(id) AS id FROM referrals WHERE client_id = ? GROUP BY resource_id').all(clientId)
      .map((r) => [r.resource_id, r.id])
  );
  for (const group of results.byNeed) {
    group.matches.forEach((m, i) => {
      if (seen.has(m.resource.id)) {
        m.referralId = seen.get(m.resource.id);
        return;
      }
      const r = insert.run(clientId, searchId, m.resource.id, group.need, m.score, i + 1);
      m.referralId = Number(r.lastInsertRowid);
      seen.set(m.resource.id, m.referralId);
    });
  }
  return { searchId, ...results };
}

// What a private (confidential) search keeps: enough to count needs and gaps
// and to let the youth check in, nothing that describes who they are.
const PRIVATE_KEEP = new Set(['age', 'county', 'language', 'needs']);

function storedProfile(profile) {
  if (!profile.confidential) return { ...profile, tags: deriveTags(profile) };
  const out = { confidential: true, tags: [] };
  for (const [k, v] of Object.entries(profile)) if (PRIVATE_KEEP.has(k)) out[k] = v;
  return out;
}

function createIntake(db, profile, { source = 'self' } = {}) {
  return tx(db, () => {
    let refCode;
    do refCode = newRefCode();
    while (db.prepare('SELECT 1 FROM clients WHERE ref_code = ?').get(refCode));

    const stored = storedProfile(profile);
    const row = { ...stored, ref_code: refCode, source, contact_ok: stored.contact_ok ? 1 : 0, confidential: stored.confidential ? 1 : 0 };
    const cols = [
      'ref_code', 'source', 'confidential', 'age', 'county', 'zip', 'race', 'sex', 'gender', 'lgbtq', 'family', 'household_size',
      'income', 'income_sources', 'housing', 'education', 'employment', 'vulnerabilities', 'needs', 'preferences',
      'language', 'tags', 'notes', 'contact_ok', 'contact_method', 'contact_value',
    ];
    const values = cols.map((c) => (CLIENT_JSON.includes(c) ? JSON.stringify(row[c] || []) : row[c] ?? null));
    const res = db
      .prepare(`INSERT INTO clients (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values);
    const clientId = Number(res.lastInsertRowid);
    return { refCode, clientId, ...runSearch(db, clientId, profile) };
  });
}

// Re-runs matching for a returning youth against the current directory and
// outcome history. Optional `needs` replaces what they asked for last time.
function refreshSearch(db, client, { needs } = {}) {
  return tx(db, () => {
    const profile = { ...client };
    if (needs) {
      profile.needs = needs;
      db.prepare('UPDATE clients SET needs = ? WHERE id = ?').run(JSON.stringify(needs), client.id);
    }
    return runSearch(db, client.id, profile);
  });
}

function getClientByCode(db, code) {
  const ref = normalizeCode(code);
  if (!ref) return null;
  return fromRow(db.prepare('SELECT * FROM clients WHERE ref_code = ?').get(ref), CLIENT_JSON);
}

function referralsFor(db, clientId) {
  return db
    .prepare(
      `SELECT r.id, r.resource_id, r.need, r.status, r.barriers, r.created_at, r.updated_at, r.score,
              r.validated_at, r.validated_by, r.validation_note,
              res.name, res.phone, res.text, res.website
         FROM referrals r JOIN resources res ON res.id = r.resource_id
        WHERE r.client_id = ?
        ORDER BY r.search_id DESC, r.need, r.rank`
    )
    .all(clientId)
    .map((r) => ({ ...r, barriers: parseJson(r.barriers, []) }));
}

function recordOutcome(db, referralId, clientId, outcome, reportedBy) {
  return tx(db, () => {
    const ref = db.prepare('SELECT id FROM referrals WHERE id = ? AND (? IS NULL OR client_id = ?)').get(referralId, clientId, clientId);
    if (!ref) return null;
    db.prepare("UPDATE referrals SET status = ?, barriers = ?, updated_at = datetime('now') WHERE id = ?").run(
      outcome.status,
      JSON.stringify(outcome.barriers),
      referralId
    );
    db.prepare('INSERT INTO outcome_events (referral_id, status, barriers, note, reported_by) VALUES (?, ?, ?, ?, ?)').run(
      referralId,
      outcome.status,
      JSON.stringify(outcome.barriers),
      outcome.note,
      reportedBy
    );
    return true;
  });
}

// Staff confirmed with the provider that the youth was actually connected.
// This marks the referral as "got help" and is weighted extra in matching.
function validateReferral(db, referralId, { by, note }) {
  return tx(db, () => {
    const ref = db.prepare('SELECT id, barriers FROM referrals WHERE id = ?').get(referralId);
    if (!ref) return null;
    db.prepare(
      `UPDATE referrals SET status = 'received', validated_at = datetime('now'), validated_by = ?, validation_note = ?,
              updated_at = datetime('now') WHERE id = ?`
    ).run(by, note, referralId);
    db.prepare("INSERT INTO outcome_events (referral_id, status, barriers, note, reported_by) VALUES (?, 'received', ?, ?, ?)").run(
      referralId,
      ref.barriers,
      note ? `Validated: ${note}` : 'Validated with provider',
      `staff (${by})`
    );
    return true;
  });
}

function unvalidateReferral(db, referralId) {
  return db
    .prepare("UPDATE referrals SET validated_at = NULL, validated_by = NULL, validation_note = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(referralId).changes > 0;
}

function eventsFor(db, clientId) {
  return db
    .prepare(
      `SELECT e.* FROM outcome_events e JOIN referrals r ON r.id = e.referral_id
        WHERE r.client_id = ? ORDER BY e.created_at DESC, e.id DESC`
    )
    .all(clientId)
    .map((e) => ({ ...e, barriers: parseJson(e.barriers, []) }));
}

function listClients(db, { q, limit = 50 } = {}) {
  const ref = normalizeCode(q);
  const rows = ref
    ? db.prepare('SELECT * FROM clients WHERE ref_code = ?').all(ref)
    : db.prepare('SELECT * FROM clients ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 50, 500));
  const counts = db.prepare(
    `SELECT COUNT(*) AS referrals,
            SUM(status = 'received') AS received,
            SUM(status != 'suggested') AS updated
       FROM referrals WHERE client_id = ?`
  );
  return rows.map((r) => {
    const c = fromRow(r, CLIENT_JSON);
    const k = counts.get(c.id);
    return {
      ref_code: c.ref_code, created_at: c.created_at, source: c.source, confidential: !!c.confidential, age: c.age, county: c.county,
      housing: c.housing, needs: c.needs, tags: c.tags, contact_ok: !!c.contact_ok,
      referrals: k.referrals, received: k.received || 0, updated: k.updated || 0,
    };
  });
}

function deleteClient(db, code) {
  const ref = normalizeCode(code);
  if (!ref) return false;
  return db.prepare('DELETE FROM clients WHERE ref_code = ?').run(ref).changes > 0;
}

// ---------- Reporting ----------

const AGE_BANDS = [
  ['9–12', 9, 12],
  ['13–15', 13, 15],
  ['16–17', 16, 17],
  ['18–20', 18, 20],
  ['21–24', 21, 24],
  ['25–26', 25, 26],
];
const ageBand = (age) => (age == null ? 'unknown' : (AGE_BANDS.find(([, lo, hi]) => age >= lo && age <= hi) || ['unknown'])[0]);

function bump(obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n;
}

function dashboard(db, { from, to, county } = {}) {
  const where = [];
  const args = [];
  if (from) where.push('c.created_at >= ?'), args.push(from);
  if (to) where.push("c.created_at < date(?, '+1 day')"), args.push(to);
  if (county) where.push('c.county = ?'), args.push(county);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const clients = db.prepare(`SELECT c.* FROM clients c ${w}`).all(...args).map((r) => fromRow(r, CLIENT_JSON));
  const searches = db.prepare(`SELECT s.* FROM searches s JOIN clients c ON c.id = s.client_id ${w}`).all(...args);
  const referrals = db
    .prepare(
      `SELECT r.*, res.name AS resource_name FROM referrals r
         JOIN clients c ON c.id = r.client_id JOIN resources res ON res.id = r.resource_id ${w}`
    )
    .all(...args);

  const clientById = new Map(clients.map((c) => [c.id, c]));
  const demo = { age: {}, county: {}, race: {}, gender: {}, lgbtq: {}, housing: {}, income: {}, education: {}, employment: {}, family: {}, vulnerabilities: {}, tags: {} };
  for (const c of clients) {
    bump(demo.age, ageBand(c.age));
    bump(demo.county, c.county || 'unknown');
    bump(demo.lgbtq, c.lgbtq || 'unknown');
    bump(demo.housing, c.housing || 'unknown');
    bump(demo.income, c.income || 'unknown');
    bump(demo.education, c.education || 'unknown');
    bump(demo.employment, c.employment || 'unknown');
    for (const r of c.race.length ? c.race : ['unknown']) bump(demo.race, r);
    for (const g of c.gender.length ? c.gender : ['unknown']) bump(demo.gender, g);
    for (const f of c.family) bump(demo.family, f);
    for (const v of c.vulnerabilities) bump(demo.vulnerabilities, v);
    for (const t of c.tags) bump(demo.tags, t);
  }

  const needs = {};
  const unmet = {};
  const weekly = {};
  for (const s of searches) {
    for (const n of parseJson(s.needs, [])) bump(needs, n);
    for (const n of parseJson(s.unmet_needs, [])) bump(unmet, n);
    const d = new Date(`${s.created_at.replace(' ', 'T')}Z`);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    bump(weekly, d.toISOString().slice(0, 10));
  }

  const outcomes = {};
  const barriers = {};
  const byResource = {};
  const byNeed = {};
  // Success by group lets staff see whether some youth are being served
  // worse than others (equity view).
  const groupDefs = {
    age: (c) => [ageBand(c.age)],
    lgbtq: (c) => [c.tags.includes('lgbtq') ? 'LGBTQIA2S+' : 'Not LGBTQIA2S+ / unknown'],
    race: (c) => (c.race.length ? c.race : ['unknown']),
    housing: (c) => [c.tags.includes('unhoused') ? 'Unhoused / unstable' : 'Housed'],
    foster: (c) => [c.tags.includes('foster') ? 'Foster experience' : 'No foster experience'],
    county: (c) => [c.county || 'unknown'],
  };
  const byGroup = Object.fromEntries(Object.keys(groupDefs).map((k) => [k, {}]));

  for (const r of referrals) {
    bump(outcomes, r.status);
    const bs = parseJson(r.barriers, []);
    for (const b of bs) bump(barriers, b);
    const res = (byResource[r.resource_id] ||= { id: r.resource_id, name: r.resource_name, referrals: 0, updated: 0, finals: 0, received: 0, validated: 0, barriers: {} });
    res.referrals++;
    if (r.validated_at) res.validated++;
    const nd = (byNeed[r.need] ||= { referrals: 0, updated: 0, finals: 0, received: 0 });
    nd.referrals++;
    const c = clientById.get(r.client_id);
    for (const [g, fn] of Object.entries(groupDefs)) {
      for (const key of fn(c)) {
        const o = (byGroup[g][key] ||= { referrals: 0, updated: 0, finals: 0, received: 0, barriers: {} });
        o.referrals++;
        if (r.status !== 'suggested') o.updated++;
        if (FINAL.has(r.status)) o.finals++;
        if (SUCCESS.has(r.status)) o.received++;
        for (const b of bs) bump(o.barriers, b);
      }
    }
    if (r.status !== 'suggested') res.updated++, nd.updated++;
    if (FINAL.has(r.status)) res.finals++, nd.finals++;
    if (SUCCESS.has(r.status)) res.received++, nd.received++;
    for (const b of bs) bump(res.barriers, b);
  }

  const finals = referrals.filter((r) => FINAL.has(r.status)).length;
  const received = referrals.filter((r) => SUCCESS.has(r.status)).length;
  const followedUp = new Set(referrals.filter((r) => r.status !== 'suggested').map((r) => r.client_id)).size;

  return {
    totals: {
      clients: clients.length,
      searches: searches.length,
      referrals: referrals.length,
      clientsFollowedUp: followedUp,
      outcomesReported: finals,
      received,
      validated: referrals.filter((r) => r.validated_at).length,
      confidential: clients.filter((c) => c.confidential).length,
      successRate: finals ? received / finals : null,
      withUnmetNeed: searches.filter((s) => parseJson(s.unmet_needs, []).length).length,
    },
    weekly: Object.entries(weekly).sort(([a], [b]) => a.localeCompare(b)),
    needs,
    unmet,
    outcomes,
    barriers,
    demographics: demo,
    byResource: Object.values(byResource).sort((a, b) => b.referrals - a.referrals),
    byNeed,
    byGroup,
  };
}

function csvCell(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
}

// De-identified export: no contact info, notes, or ZIP; reference codes are
// replaced with an internal row number.
function exportReferralsCsv(db) {
  const rows = db
    .prepare(
      `SELECT c.id AS client, c.created_at AS intake_date, c.source, c.age, c.county, c.race, c.sex, c.gender, c.lgbtq,
              c.family, c.income, c.housing, c.education, c.employment, c.vulnerabilities, c.tags,
              c.confidential, r.id AS referral, r.need, r.resource_id, res.name AS resource_name, r.score, r.rank, r.status,
              r.barriers, r.validated_at IS NOT NULL AS validated, r.updated_at
         FROM referrals r JOIN clients c ON c.id = r.client_id JOIN resources res ON res.id = r.resource_id
        ORDER BY r.id`
    )
    .all();
  const cols = rows.length
    ? Object.keys(rows[0])
    : ['client', 'intake_date', 'source', 'age', 'county', 'referral', 'need', 'resource_id', 'status', 'barriers'];
  const json = new Set(['race', 'gender', 'family', 'vulnerabilities', 'tags', 'barriers']);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(json.has(c) ? parseJson(r[c], []) : r[c])).join(','));
  return lines.join('\n') + '\n';
}

// Visible text only, so rotating ads/scripts/tokens don't count as changes.
function hashPageText(html) {
  const text = String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Checks every active resource's website and records whether it loaded.
// `fetchImpl` is injectable for tests.
async function checkLinks(db, { fetchImpl = fetch, timeoutMs = 8000, concurrency = 6 } = {}) {
  const rows = db.prepare("SELECT id, website, page_hash FROM resources WHERE active = 1 AND website IS NOT NULL AND website != ''").all();
  const update = db.prepare("UPDATE resources SET link_status = ?, link_checked_at = datetime('now') WHERE id = ?");
  // A program's own website changing is a hint its details (hours, rules,
  // funding) changed too, so staff are asked to re-verify.
  const updateHash = db.prepare(
    `UPDATE resources SET page_hash = ?,
            page_changed_at = CASE WHEN page_hash IS NOT NULL AND page_hash != ? THEN datetime('now') ELSE page_changed_at END
      WHERE id = ?`
  );
  const summary = { checked: 0, ok: 0, broken: [], changed: [] };
  const check = async (url) => {
    try {
      const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      // Plenty of sites block bots; only a 404/410 is a clear "gone".
      if (!res.ok) return { status: res.status === 404 || res.status === 410 ? `broken (${res.status})` : 'ok' };
      const body = typeof res.text === 'function' ? await res.text().catch(() => null) : null;
      return { status: 'ok', hash: body == null ? null : hashPageText(body) };
    } catch (err) {
      return { status: `unreachable (${err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message})`.slice(0, 80) };
    }
  };
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      const { status, hash } = await check(r.website);
      update.run(status, r.id);
      if (hash) {
        if (r.page_hash && r.page_hash !== hash) summary.changed.push(r.id);
        updateHash.run(hash, hash, r.id);
      }
      summary.checked++;
      if (status === 'ok') summary.ok++;
      else summary.broken.push({ id: r.id, website: r.website, status });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return summary;
}

module.exports = {
  createIntake,
  refreshSearch,
  validateReferral,
  unvalidateReferral,
  checkLinks,
  getClientByCode,
  referralsFor,
  recordOutcome,
  eventsFor,
  listClients,
  deleteClient,
  resourceStats,
  dashboard,
  exportReferralsCsv,
  normalizeCode,
};
