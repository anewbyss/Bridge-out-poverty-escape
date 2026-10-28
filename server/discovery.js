'use strict';

// Discovery: finds organizations serving youth in the Portland daily-access
// area from public records, and queues them as leads for staff review.
//
// Sources:
//   usaspending  federal grants and subawards (public contracting) for youth,
//                housing, utility, safety, reentry, and workforce programs
//   irs_bmf      IRS Exempt Organizations list: established nonprofits by
//                activity code (NTEE) in access-area cities
//   webpage      public county listings and community-network member pages
//
// Records say who is funded or listed, not exactly what a young person can
// walk in for, so leads go to a review queue rather than straight to youth.

const crypto = require('node:crypto');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { parseJson } = require('./db');

// Access-area cities and their counties (the county is used when a lead is
// added to the directory).
const CITY_COUNTY = {
  portland: 'multnomah', gresham: 'multnomah', troutdale: 'multnomah', fairview: 'multnomah', 'wood village': 'multnomah', 'maywood park': 'multnomah',
  beaverton: 'washington', hillsboro: 'washington', tigard: 'washington', tualatin: 'washington', sherwood: 'washington', aloha: 'washington',
  cornelius: 'washington', 'forest grove': 'washington', 'king city': 'washington',
  'lake oswego': 'clackamas', 'west linn': 'clackamas', milwaukie: 'clackamas', 'oregon city': 'clackamas', gladstone: 'clackamas',
  'happy valley': 'clackamas', clackamas: 'clackamas', damascus: 'clackamas', 'oak grove': 'clackamas', wilsonville: 'clackamas',
  vancouver: 'clark', camas: 'clark', washougal: 'clark', 'battle ground': 'clark', ridgefield: 'clark',
};
const WA_CITIES = new Set(['vancouver', 'camas', 'washougal', 'battle ground', 'ridgefield']);

// Federal assistance listings (CFDA) that fund the kinds of help this tool
// matches. `youth` marks programs specifically for young people.
const FEDERAL_PROGRAMS = [
  { cfda: '93.550', name: 'Transitional Living for Homeless Youth', needs: ['housing'], youth: true },
  { cfda: '93.623', name: 'Basic Center (runaway & homeless youth)', needs: ['emergency_shelter', 'crisis'], youth: true },
  { cfda: '93.557', name: 'Street Outreach for runaway & homeless youth', needs: ['basic_needs', 'safety'], youth: true },
  { cfda: '17.259', name: 'WIOA Youth workforce', needs: ['employment', 'education'], youth: true },
  { cfda: '17.274', name: 'YouthBuild', needs: ['education', 'employment'], youth: true },
  { cfda: '93.674', name: 'Chafee foster youth transition', needs: ['housing', 'education'], youth: true },
  { cfda: '14.267', name: 'HUD Continuum of Care', needs: ['housing'] },
  { cfda: '14.231', name: 'Emergency Solutions Grant', needs: ['emergency_shelter', 'rent_assistance'] },
  { cfda: '97.024', name: 'Emergency Food and Shelter', needs: ['food', 'emergency_shelter', 'rent_assistance'] },
  { cfda: '93.568', name: 'LIHEAP energy assistance', needs: ['utility_assistance'] },
  { cfda: '93.569', name: 'Community Services Block Grant', needs: ['rent_assistance', 'utility_assistance'] },
  { cfda: '16.575', name: 'Crime Victim Assistance (VOCA)', needs: ['safety'] },
  { cfda: '16.588', name: 'Violence Against Women (STOP)', needs: ['safety'] },
  { cfda: '93.671', name: 'Family Violence Prevention and Services', needs: ['safety', 'emergency_shelter'] },
  { cfda: '16.812', name: 'Second Chance Act reentry', needs: ['legal', 'employment', 'housing'], reentry: true },
  { cfda: '93.556', name: 'Promoting Safe and Stable Families', needs: ['parenting'] },
];

// IRS activity codes (NTEE) → needs. Longest matching prefix wins.
const NTEE = [
  ['L4', ['emergency_shelter', 'housing']],
  ['L82', ['rent_assistance', 'utility_assistance']],
  ['L', ['housing']],
  ['P43', ['safety', 'emergency_shelter']],
  ['P30', ['mentoring', 'basic_needs'], 'youth'],
  ['P32', ['housing', 'mentoring'], 'youth'],
  ['P4', ['parenting']],
  ['P60', ['rent_assistance', 'utility_assistance', 'basic_needs']],
  ['P84', ['mentoring']],
  ['P85', ['basic_needs', 'housing']],
  ['P88', ['lgbtq_support']],
  ['P20', ['basic_needs']],
  ['O', ['mentoring'], 'youth'],
  ['K3', ['food']],
  ['J2', ['employment']],
  ['F2', ['substance_use']],
  ['F3', ['mental_health']],
  ['F4', ['crisis', 'mental_health']],
  ['I4', ['legal']],
  ['I7', ['safety']],
  ['I8', ['legal']],
  ['B6', ['education']],
  ['B92', ['education']],
  ['E32', ['health']],
  ['E4', ['health']],
];

const GOVERNMENT = /\b(county|city of|state of|department of|dept of|university|school district|board of|commission)\b/i;
const SKIP_LINK_HOSTS = /(^|\.)(facebook|twitter|x|instagram|linkedin|youtube|tiktok|google|apple|adobe|pinterest|flickr|vimeo|wordpress|squarespace|wix|addthis|sharethis|bit)\.(com|ly|org)$/i;
const GENERIC_TEXT = /^(click here|here|learn more|read more|more|website|visit( website)?|home|donate|contact( us)?|about( us)?|menu|search|skip to .*|privacy.*|terms.*|login|log in|sign up|subscribe|facebook|twitter|instagram|linkedin|youtube|email|map|directions|pdf|download)$/i;

function nteeNeeds(code) {
  const c = String(code || '').toUpperCase();
  let best = null;
  for (const row of NTEE) if (c.startsWith(row[0]) && (!best || row[0].length > best[0].length)) best = row;
  return best ? { needs: best[1], youth: best[2] === 'youth' } : null;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|corp|corporation|co|the|dba|a)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const SMALL = new Set(['and', 'of', 'for', 'the', 'in', 'on', 'at', 'to', 'a']);
function titleCase(s) {
  const str = String(s || '').trim();
  if (str !== str.toUpperCase()) return str; // already mixed case
  return str
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/^[a-z]/, (c) => c.toUpperCase())))
    .join(' ')
    .replace(/\b(Inc|Llc)\b/g, (m) => m.toUpperCase() === 'LLC' ? 'LLC' : 'Inc');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function pageText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// External links on a listing page, as candidate organizations.
function extractLinks(html, pageUrl) {
  const host = new URL(pageUrl).hostname.replace(/^www\./, '');
  const out = new Map();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url;
    try {
      url = new URL(decodeEntities(m[1]), pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const h = url.hostname.replace(/^www\./, '');
    if (h === host || h.endsWith(`.${host}`) || SKIP_LINK_HOSTS.test(h)) continue;
    let text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) text = '';
    if (!text || text.length < 3 || text.length > 100 || GENERIC_TEXT.test(text)) continue;
    const key = normalizeName(text);
    if (key && !out.has(key)) out.set(key, { name: text, website: `${url.protocol}//${url.host}` });
  }
  return [...out.values()];
}

// Minimal quote-aware CSV line splitter (IRS files are simple CSV).
function splitCsv(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

function fiscalWindow(now = new Date(), years = 3) {
  const y = now.getUTCFullYear() - years;
  return [{ start_date: `${y}-10-01`, end_date: now.toISOString().slice(0, 10) }];
}

const money = (n) => (n == null || Number.isNaN(Number(n)) ? '' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);

const DEFAULT_SOURCES = [
  {
    id: 'usaspending',
    kind: 'usaspending',
    name: 'Federal grants & subawards (USAspending.gov)',
    url: 'https://api.usaspending.gov/api/v2/search/spending_by_award/',
    config: {},
  },
  {
    id: 'irs-or',
    kind: 'irs_bmf',
    name: 'IRS nonprofit registry — Oregon',
    url: 'https://www.irs.gov/pub/irs-soi/eo_or.csv',
    config: { state: 'OR', minRevenue: 25000 },
  },
  {
    id: 'irs-wa',
    kind: 'irs_bmf',
    name: 'IRS nonprofit registry — Washington (Clark County cities)',
    url: 'https://www.irs.gov/pub/irs-soi/eo_wa.csv',
    config: { state: 'WA', minRevenue: 25000 },
  },
  {
    id: 'ocadsv-members',
    kind: 'webpage',
    name: 'Oregon Coalition Against Domestic & Sexual Violence — member programs',
    url: 'https://ocadsv.org/?p=115',
    config: { needs: ['safety'], network: true },
  },
  {
    id: 'multco-shelter',
    kind: 'webpage',
    name: 'Multnomah County — shelter and homeless services page',
    url: 'https://www.multco.us/dd/shelter-and-homeless-services',
    config: { needs: ['emergency_shelter', 'housing'] },
  },
];

function createDiscovery(db, { fetchImpl = fetch, timeoutMs = 60000, now = () => new Date() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_status TEXT,
      last_found INTEGER,
      page_hash TEXT,
      page_changed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      city TEXT,
      state TEXT,
      address TEXT,
      website TEXT,
      needs TEXT NOT NULL DEFAULT '[]',
      populations TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      resource_id TEXT,
      note TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  `);
  const insertSource = db.prepare(
    'INSERT OR IGNORE INTO discovery_sources (id, kind, name, url, config) VALUES (?, ?, ?, ?, ?)'
  );
  for (const s of DEFAULT_SOURCES) insertSource.run(s.id, s.kind, s.name, s.url, JSON.stringify(s.config));

  const sourceRow = (r) => r && { ...r, config: parseJson(r.config, {}), enabled: !!r.enabled };
  const getSource = (id) => sourceRow(db.prepare('SELECT * FROM discovery_sources WHERE id = ?').get(id));
  const listSources = () => db.prepare('SELECT * FROM discovery_sources ORDER BY created_at, id').all().map(sourceRow);

  // Existing directory entries by normalized name, so known programs are
  // linked rather than suggested again.
  function directoryIndex() {
    const idx = new Map();
    for (const r of db.prepare('SELECT id, name, org FROM resources').all()) {
      for (const n of [r.name, r.org]) {
        const k = normalizeName(n);
        if (k.length >= 4 && !idx.has(k)) idx.set(k, r.id);
      }
    }
    return idx;
  }
  function findResource(idx, key) {
    if (idx.has(key)) return idx.get(key);
    if (key.length < 10) return null;
    // Near-identical names only (e.g. "x youth programs" vs "x youth
    // programs of oregon"), never a short name inside a long one.
    for (const [k, id] of idx) {
      const [short, long] = k.length < key.length ? [k, key] : [key, k];
      if (short.length >= 10 && long.startsWith(short) && short.length / long.length >= 0.75) return id;
    }
    return null;
  }

  // Adds or merges a lead. Evidence is de-duplicated by its `id`.
  function upsertLead(idx, lead, evidence, points) {
    const key = normalizeName(lead.name);
    if (!key || key.length < 3) return false;
    const cur = db.prepare('SELECT * FROM leads WHERE key = ?').get(key);
    if (!cur) {
      const resourceId = findResource(idx, key);
      db.prepare(
        `INSERT INTO leads (key, name, city, state, address, website, needs, populations, evidence, score, status, resource_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        key, titleCase(lead.name), lead.city || null, lead.state || null, lead.address || null, lead.website || null,
        JSON.stringify(lead.needs || []), JSON.stringify(lead.populations || []), JSON.stringify([evidence]),
        points, resourceId ? 'known' : 'new', resourceId
      );
      return true;
    }
    const ev = parseJson(cur.evidence, []);
    const isNewEvidence = !ev.some((e) => e.id === evidence.id);
    if (isNewEvidence) ev.push(evidence);
    // Independent sources agreeing is the strongest signal of an established program.
    const sources = new Set(ev.map((e) => e.source));
    const score = isNewEvidence ? cur.score + points + (sources.size > 1 && !new Set(parseJson(cur.evidence, []).map((e) => e.source)).has(evidence.source) ? 15 : 0) : cur.score;
    db.prepare(
      `UPDATE leads SET city = COALESCE(city, ?), state = COALESCE(state, ?), address = COALESCE(address, ?), website = COALESCE(website, ?),
              needs = ?, populations = ?, evidence = ?, score = ?, last_seen = datetime('now') WHERE id = ?`
    ).run(
      lead.city || null, lead.state || null, lead.address || null, lead.website || null,
      JSON.stringify([...new Set([...parseJson(cur.needs, []), ...(lead.needs || [])])]),
      JSON.stringify([...new Set([...parseJson(cur.populations, []), ...(lead.populations || [])])]),
      JSON.stringify(ev.slice(-25)), score, cur.id
    );
    return isNewEvidence;
  }

  async function get(url, opts = {}) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return res;
  }

  // ---------- Runners ----------
  const runners = {
    async usaspending(src) {
      const counties = [
        { country: 'USA', state: 'OR', county: '051' }, // Multnomah
        { country: 'USA', state: 'OR', county: '067' }, // Washington
        { country: 'USA', state: 'OR', county: '005' }, // Clackamas
        { country: 'USA', state: 'WA', county: '011' }, // Clark
      ];
      const time_period = fiscalWindow(now());
      const idx = directoryIndex();
      let found = 0;
      const notes = [];
      const post = (body) =>
        get(src.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

      for (const prog of src.config.programs || FEDERAL_PROGRAMS) {
        const base = { award_type_codes: ['02', '03', '04', '05'], program_numbers: [prog.cfda], time_period };
        const pops = prog.reentry ? ['reentry', 'justice'] : [];
        // Prime awards to organizations based in the access-area counties.
        for (let page = 1; page <= 3; page++) {
          const body = await post({
            filters: { ...base, recipient_locations: counties },
            fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Start Date', 'Awarding Agency', 'Description', 'generated_internal_id'],
            limit: 100,
            page,
            sort: 'Award Amount',
            order: 'desc',
          });
          for (const a of body.results || []) {
            const name = a['Recipient Name'];
            if (!name) continue;
            const gov = GOVERNMENT.test(name);
            const points = (prog.youth ? 40 : 25) - (gov ? 20 : 0);
            const added = upsertLead(idx, { name, needs: prog.needs, populations: pops }, {
              id: `usa:${a['generated_internal_id'] || a['Award ID']}`,
              source: 'Federal grants',
              detail: `${prog.name} grant${a['Award Amount'] != null ? ` · ${money(a['Award Amount'])}` : ''}${a['Start Date'] ? ` · ${String(a['Start Date']).slice(0, 4)}` : ''}${a['Awarding Agency'] ? ` · ${a['Awarding Agency']}` : ''}`,
              url: a['generated_internal_id'] ? `https://www.usaspending.gov/award/${encodeURIComponent(a['generated_internal_id'])}` : null,
              youth: !!prog.youth,
            }, points);
            if (added) found++;
          }
          if (!body.page_metadata?.hasNext) break;
        }
        // Subawards: money passed through the state or county to local
        // providers, which is how most youth and housing programs are funded.
        try {
          for (let page = 1; page <= 3; page++) {
            const body = await post({
              subawards: true,
              spending_level: 'subawards',
              filters: { ...base, place_of_performance_locations: counties },
              fields: ['Sub-Award ID', 'Sub-Awardee Name', 'Sub-Award Amount', 'Sub-Award Date', 'Prime Recipient Name'],
              limit: 100,
              page,
            });
            for (const a of body.results || []) {
              const name = a['Sub-Awardee Name'];
              if (!name) continue;
              const points = (prog.youth ? 35 : 20) - (GOVERNMENT.test(name) ? 20 : 0);
              const added = upsertLead(idx, { name, needs: prog.needs, populations: pops }, {
                id: `usa-sub:${a['Sub-Award ID'] || `${name}-${a['Sub-Award Date']}`}:${prog.cfda}`,
                source: 'Federal grants',
                detail: `${prog.name} subaward${a['Sub-Award Amount'] ? ` · ${money(a['Sub-Award Amount'])}` : ''}${a['Prime Recipient Name'] ? ` via ${titleCase(a['Prime Recipient Name'])}` : ''}${a['Sub-Award Date'] ? ` · ${String(a['Sub-Award Date']).slice(0, 4)}` : ''}`,
                youth: !!prog.youth,
              }, points);
              if (added) found++;
            }
            if (!body.page_metadata?.hasNext) break;
          }
        } catch (err) {
          notes.push(`subawards ${prog.cfda}: ${err.message}`);
        }
      }
      return { found, note: notes.length ? `${notes.length} subaward lookups failed` : null };
    },

    async irs_bmf(src) {
      const { state = 'OR', minRevenue = 25000 } = src.config;
      const res = await get(src.url);
      const rl = readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
      const idx = directoryIndex();
      let header = null;
      let found = 0;
      db.exec('BEGIN');
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          const cols = splitCsv(line);
          if (!header) {
            header = Object.fromEntries(cols.map((c, i) => [c.trim().toUpperCase(), i]));
            continue;
          }
          const f = (k) => (cols[header[k]] || '').trim();
          const city = f('CITY').toLowerCase();
          if (!CITY_COUNTY[city] || (state === 'OR') === WA_CITIES.has(city)) continue;
          const ntee = nteeNeeds(f('NTEE_CD'));
          if (!ntee) continue;
          const revenue = Number(f('REVENUE_AMT')) || 0;
          if (revenue < minRevenue) continue;
          const points = 10 + (ntee.youth ? 15 : 0) + (revenue >= 1e6 ? 10 : revenue >= 250000 ? 5 : 0);
          const added = upsertLead(idx, {
            name: f('NAME'),
            city: titleCase(f('CITY')),
            state: f('STATE'),
            address: titleCase(`${f('STREET')}, ${f('CITY')}`) + `, ${f('STATE')} ${f('ZIP').slice(0, 5)}`,
            needs: ntee.needs,
          }, {
            id: `irs:${f('EIN')}`,
            source: 'IRS nonprofit registry',
            detail: `Registered nonprofit (activity code ${f('NTEE_CD')}) · yearly revenue ${money(revenue)}`,
            url: `https://apps.irs.gov/app/eos/details/?ein=${f('EIN')}`,
            youth: ntee.youth,
          }, points);
          if (added) found++;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      if (!header) throw new Error('File was empty');
      return { found };
    },

    async webpage(src) {
      const res = await get(src.url, { headers: { Accept: 'text/html', 'User-Agent': 'BridgeOutOfPoverty/1.0 (resource directory check)' } });
      const html = await res.text();
      const hash = crypto.createHash('sha256').update(pageText(html)).digest('hex');
      const changed = src.page_hash && src.page_hash !== hash;
      db.prepare(`UPDATE discovery_sources SET page_hash = ?, page_changed_at = CASE WHEN ? THEN datetime('now') ELSE page_changed_at END WHERE id = ?`)
        .run(hash, changed ? 1 : 0, src.id);
      const idx = directoryIndex();
      let found = 0;
      for (const link of extractLinks(html, src.url)) {
        const added = upsertLead(idx, { ...link, needs: src.config.needs || [] }, {
          id: `web:${src.id}`,
          source: src.config.network ? 'Community network' : 'Public listing',
          detail: `Listed on ${src.name}`,
          url: src.url,
        }, src.config.network ? 30 : 20);
        if (added) found++;
      }
      return { found, note: changed ? 'Page changed since last check' : null };
    },
  };

  async function runSource(id) {
    const src = getSource(id);
    if (!src) return null;
    const runner = runners[src.kind];
    let status;
    let found = null;
    try {
      const r = await runner(src);
      found = r.found;
      status = `ok${r.note ? ` · ${r.note}` : ''}`;
    } catch (err) {
      status = `error · ${err.name === 'TimeoutError' ? 'timed out' : err.message}`.slice(0, 200);
    }
    db.prepare("UPDATE discovery_sources SET last_run_at = datetime('now'), last_status = ?, last_found = ? WHERE id = ?").run(status, found, id);
    return { id, status, found };
  }

  async function runAll() {
    const out = [];
    for (const s of listSources()) if (s.enabled) out.push(await runSource(s.id));
    return out;
  }

  function addWebpageSource({ name, url, needs = [], network = false }) {
    const id = `web-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 10)}`;
    db.prepare(
      `INSERT INTO discovery_sources (id, kind, name, url, config) VALUES (?, 'webpage', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config`
    ).run(id, name, url, JSON.stringify({ needs, network }));
    return getSource(id);
  }

  function setSourceEnabled(id, enabled) {
    return db.prepare('UPDATE discovery_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  function deleteSource(id) {
    if (DEFAULT_SOURCES.some((s) => s.id === id)) return false;
    return db.prepare('DELETE FROM discovery_sources WHERE id = ?').run(id).changes > 0;
  }

  const leadRow = (r) => r && {
    ...r,
    needs: parseJson(r.needs, []),
    populations: parseJson(r.populations, []),
    evidence: parseJson(r.evidence, []),
    county: CITY_COUNTY[String(r.city || '').toLowerCase()] || null,
  };

  function listLeads({ status = 'new', q, need, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (status && status !== 'all') where.push('status = ?'), args.push(status);
    if (q) where.push('(name LIKE ? OR city LIKE ?)'), args.push(`%${q}%`, `%${q}%`);
    if (need) where.push('needs LIKE ?'), args.push(`%"${need}"%`);
    const rows = db
      .prepare(`SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY score DESC, name LIMIT ?`)
      .all(...args, Math.min(Number(limit) || 200, 1000))
      .map(leadRow);
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all().map((r) => [r.status, r.n]));
    return { leads: rows, counts };
  }

  const getLead = (id) => leadRow(db.prepare('SELECT * FROM leads WHERE id = ?').get(id));

  function setLeadStatus(id, status, { resourceId = null, note = null } = {}) {
    return db
      .prepare('UPDATE leads SET status = ?, resource_id = COALESCE(?, resource_id), note = COALESCE(?, note) WHERE id = ?')
      .run(status, resourceId, note, id).changes > 0;
  }

  // Public records about programs already in the directory ("publicly funded").
  function evidenceForResource(resourceId) {
    return db
      .prepare('SELECT evidence FROM leads WHERE resource_id = ?')
      .all(resourceId)
      .flatMap((r) => parseJson(r.evidence, []));
  }

  return { listSources, runSource, runAll, addWebpageSource, setSourceEnabled, deleteSource, listLeads, getLead, setLeadStatus, evidenceForResource };
}

module.exports = { createDiscovery, extractLinks, nteeNeeds, normalizeName, titleCase, splitCsv, FEDERAL_PROGRAMS, CITY_COUNTY };
