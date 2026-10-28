'use strict';

// Live lookup: pulls current listings from outside service directories,
// keeps only programs within a reasonable daily trip of Portland, and saves
// them into the resources table so they can be matched, referred, tracked,
// verified, and favored like any other program.
//
// Providers are configured with environment variables (see README):
//   HSDS_API_URL (+ HSDS_API_KEY, HSDS_LABEL)  any Open Referral (HSDS) API
//   NDP_SEARCH_URL + NDP_API_KEY                211 National Data Platform search

const { upsertResource, getResource } = require('./db');
const { ACCESS_COUNTIES } = require('./taxonomy');

// Downtown Portland. A program counts as "daily access" if it is within the
// radius (by coordinates) or, when a listing has no coordinates, if its
// address is in one of the cities below. 25 miles covers Gresham, Hillsboro,
// Forest Grove, Oregon City, Vancouver and Camas — about an hour by transit.
const DEFAULT_CENTER = { lat: 45.5152, lon: -122.6784 };
const DEFAULT_RADIUS_MILES = 25;
const ACCESS_CITIES = [
  'portland', 'gresham', 'troutdale', 'fairview', 'wood village', 'maywood park', 'beaverton', 'hillsboro', 'tigard',
  'tualatin', 'sherwood', 'aloha', 'cornelius', 'forest grove', 'king city', 'lake oswego', 'west linn', 'milwaukie',
  'oregon city', 'gladstone', 'happy valley', 'clackamas', 'damascus', 'oak grove', 'johnson city', 'wilsonville',
  'vancouver', 'camas', 'washougal', 'battle ground', 'ridgefield',
];

// Search words per need. Kept plain so they work with any keyword search.
const NEED_KEYWORDS = {
  emergency_shelter: ['youth shelter', 'emergency shelter'],
  housing: ['transitional housing youth', 'housing assistance'],
  rent_assistance: ['rent assistance', 'move-in assistance'],
  eviction_help: ['eviction prevention', 'tenant legal'],
  utility_assistance: ['utility assistance', 'energy assistance'],
  food: ['food pantry', 'free meals'],
  basic_needs: ['showers laundry', 'clothing'],
  phone_internet: ['phone assistance', 'internet assistance'],
  transportation: ['transportation assistance', 'bus pass'],
  id_documents: ['identification documents', 'birth certificate assistance'],
  health: ['youth clinic', 'free clinic'],
  mental_health: ['youth counseling', 'mental health'],
  substance_use: ['youth substance use', 'addiction treatment'],
  education: ['GED', 'youth education'],
  employment: ['youth employment', 'job training'],
  mentoring: ['youth mentoring'],
  legal: ['legal aid'],
  lgbtq_support: ['LGBTQ youth'],
  parenting: ['young parents', 'pregnancy support'],
  safety: ['domestic violence', 'sexual assault advocacy'],
  crisis: ['crisis line'],
};

const CACHE_HOURS = 12;
const STALE_DAYS = 30;

function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

const first = (...vals) => vals.find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? null : String(v).trim() || null);

function formatAddress(a) {
  if (!a) return null;
  if (typeof a === 'string') return a;
  const line = first(a.address_1, a.address1, a.street, a.line1, a.streetAddress);
  const parts = [line, first(a.city, a.locality), first(a.state_province, a.state, a.region), first(a.postal_code, a.zip, a.postalCode)];
  return parts.filter(Boolean).join(', ') || null;
}

function websiteOk(u) {
  const s = str(u);
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withScheme).protocol.startsWith('http') ? withScheme : null;
  } catch {
    return null;
  }
}

// ---------- Open Referral / HSDS ----------
// Handles HSDS API v3 ({ contents: [...] }) and older APIs that return a
// plain array. Services may embed organization, phones and locations.
function hsdsProvider({ url, apiKey, label = 'Open Referral directory', fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  return {
    id: 'hsds',
    label,
    async search({ keyword, signal }) {
      const q = new URLSearchParams({ search: keyword, per_page: '50', page: '1' });
      const res = await fetchImpl(`${base}/services?${q}`, {
        headers: { Accept: 'application/json', ...(apiKey ? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` } : {}) },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body) ? body : first(body.contents, body.data, body.items, body.results) || [];
      return list.map((s) => {
        const org = s.organization || {};
        const sal = asArray(s.service_at_locations).map((x) => x.location || x);
        const locs = [...sal, ...asArray(s.locations)];
        const loc = locs[0] || {};
        const addr = first(asArray(loc.addresses)[0], asArray(loc.physical_addresses)[0], asArray(loc.physical_address)[0], loc.address);
        return {
          externalId: str(first(s.id, s.service_id)),
          name: str(s.name),
          org: str(first(org.name, s.organization_name)),
          description: str(first(s.description, org.description)),
          phone: str(first(asArray(s.phones)[0]?.number, asArray(org.phones)[0]?.number, asArray(loc.phones)[0]?.number)),
          website: websiteOk(first(s.url, org.website, org.url)),
          email: str(first(s.email, org.email)),
          address: formatAddress(addr),
          city: str(first(addr?.city, addr?.locality)),
          lat: num(first(loc.latitude, loc.lat)),
          lon: num(first(loc.longitude, loc.lon, loc.lng)),
          hours: str(first(asArray(s.schedules)[0]?.description, s.hours)),
          eligibility: str(first(s.eligibility_description, asArray(s.eligibility)[0]?.description, s.eligibility)),
          updatedAt: str(first(s.last_modified, s.updated_at)),
        };
      });
    },
  };
}

// ---------- 211 National Data Platform ----------
// The NDP search API is behind a subscription key. Its response shape has
// changed between versions, so parsing is deliberately tolerant. Verify field
// names against the API portal once you have a key.
function ndpProvider({ url, apiKey, location = 'Portland, OR', distance = DEFAULT_RADIUS_MILES, label = '211', fetchImpl = fetch }) {
  return {
    id: 'ndp211',
    label,
    async search({ keyword, signal }) {
      const q = new URLSearchParams({ keyword, location, distance: String(distance), top: '50' });
      const res = await fetchImpl(`${url}${url.includes('?') ? '&' : '?'}${q}`, {
        headers: { Accept: 'application/json', 'Api-Key': apiKey, 'Ocp-Apim-Subscription-Key': apiKey },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body) ? body : first(body.results, body.value, body.data, body.items, body.records) || [];
      return list.map((raw) => {
        const r = raw.document || raw;
        const addr = first(r.address, asArray(r.addresses)[0], r.location?.address, r.physicalAddress);
        return {
          externalId: str(first(r.idServiceAtLocation, r.serviceAtLocationId, r.idService, r.serviceId, r.id)),
          name: str(first(r.nameService, r.serviceName, r.name)),
          org: str(first(r.nameOrganization, r.organizationName, r.organization?.name)),
          description: str(first(r.descriptionService, r.serviceDescription, r.description)),
          phone: str(first(asArray(r.phones)[0]?.number, r.phone, r.phoneNumber)),
          website: websiteOk(first(r.website, r.url, r.organization?.website)),
          email: str(first(r.email)),
          address: formatAddress(addr),
          city: str(first(addr?.city, r.city)),
          lat: num(first(r.latitude, r.location?.latitude, r.geoLocation?.coordinates?.[1])),
          lon: num(first(r.longitude, r.location?.longitude, r.geoLocation?.coordinates?.[0])),
          hours: str(first(r.hours, r.scheduleDescription)),
          eligibility: str(first(r.eligibility, r.eligibilityDescription)),
          updatedAt: str(first(r.lastVerifiedOn, r.lastUpdated, r.updatedAt)),
        };
      });
    },
  };
}

function providersFromEnv(env = process.env, fetchImpl = fetch) {
  const out = [];
  if (env.HSDS_API_URL) out.push(hsdsProvider({ url: env.HSDS_API_URL, apiKey: env.HSDS_API_KEY, label: env.HSDS_LABEL || undefined, fetchImpl }));
  if (env.NDP_SEARCH_URL && env.NDP_API_KEY)
    out.push(ndpProvider({ url: env.NDP_SEARCH_URL, apiKey: env.NDP_API_KEY, location: env.NDP_LOCATION || undefined, fetchImpl }));
  return out;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function createLive(db, { providers = [], center = DEFAULT_CENTER, radiusMiles = DEFAULT_RADIUS_MILES, timeoutMs = 4000, cacheHours = CACHE_HOURS } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS live_queries (
    provider TEXT NOT NULL,
    need TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    found INTEGER NOT NULL DEFAULT 0,
    kept INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, need)
  )`);

  function inAccessArea(item) {
    if (item.lat != null && item.lon != null) return milesBetween(center, { lat: item.lat, lon: item.lon }) <= radiusMiles;
    const city = (item.city || item.address || '').toLowerCase();
    return ACCESS_CITIES.some((c) => new RegExp(`(^|[^a-z])${c}([^a-z]|$)`).test(city));
  }

  // Saves one listing. Existing live rows get fresh details unless staff
  // edited or verified them; their categories grow as they turn up for more needs.
  function save(provider, item, need) {
    const id = `live-${provider.id}-${slug(item.externalId || `${item.org || ''} ${item.name}`)}`;
    const cur = getResource(db, id);
    if (cur && (cur.edited || cur.last_verified)) {
      if (!cur.categories.includes(need)) upsertResource(db, { ...cur, categories: [...cur.categories, need] });
      db.prepare("UPDATE resources SET live_seen_at = datetime('now') WHERE id = ?").run(id);
      return id;
    }
    const miles = item.lat != null && item.lon != null ? milesBetween(center, item) : null;
    upsertResource(db, {
      id,
      name: item.name,
      org: item.org,
      description: item.description,
      categories: [...new Set([...(cur?.categories || []), need])],
      counties: ['access_area'],
      age_min: 0,
      age_max: 120,
      phone: item.phone,
      website: item.website,
      address: item.address,
      hours: item.hours,
      eligibility: item.eligibility || 'Call to confirm who qualifies (age, income, area).',
      flags: cur?.flags || [],
      active: true,
      last_verified: null,
    }, { source: `live:${provider.id}`, edited: 0 });
    db.prepare("UPDATE resources SET live_seen_at = datetime('now'), live_provider = ?, live_miles = ? WHERE id = ?")
      .run(provider.label, miles == null ? null : Math.round(miles * 10) / 10, id);
    return id;
  }

  async function fetchNeed(provider, need) {
    const items = new Map();
    for (const keyword of NEED_KEYWORDS[need] || []) {
      for (const it of await provider.search({ keyword, signal: AbortSignal.timeout(timeoutMs) })) {
        if (it.name) items.set(it.externalId || it.name, it);
      }
    }
    const kept = [...items.values()].filter(inAccessArea);
    db.exec('BEGIN');
    try {
      for (const it of kept) save(provider, it, need);
      db.prepare(
        `INSERT INTO live_queries (provider, need, fetched_at, ok, error, found, kept) VALUES (?, ?, datetime('now'), 1, NULL, ?, ?)
         ON CONFLICT(provider, need) DO UPDATE SET fetched_at = excluded.fetched_at, ok = 1, error = NULL, found = excluded.found, kept = excluded.kept`
      ).run(provider.id, need, items.size, kept.length);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return kept.length;
  }

  function recordError(provider, need, err) {
    db.prepare(
      `INSERT INTO live_queries (provider, need, fetched_at, ok, error) VALUES (?, ?, datetime('now'), 0, ?)
       ON CONFLICT(provider, need) DO UPDATE SET fetched_at = excluded.fetched_at, ok = 0, error = excluded.error`
    ).run(provider.id, need, String(err.name === 'TimeoutError' ? 'timed out' : err.message).slice(0, 200));
  }

  const fresh = db.prepare(
    `SELECT 1 FROM live_queries WHERE provider = ? AND need = ? AND ok = 1 AND fetched_at > datetime('now', ?)`
  );

  /**
   * Makes sure live listings for these needs are no older than the cache
   * window. Never throws: on any failure we fall back to what's saved.
   */
  async function refreshNeeds(needs, { force = false } = {}) {
    const summary = { fetched: 0, cached: 0, kept: 0, errors: [] };
    await Promise.all(
      providers.flatMap((p) =>
        needs.map(async (need) => {
          if (!NEED_KEYWORDS[need]) return;
          if (!force && fresh.get(p.id, need, `-${cacheHours} hours`)) return void summary.cached++;
          try {
            // Await first: `x += await y` would read x before the wait and
            // lose counts from lookups running at the same time.
            const kept = await fetchNeed(p, need);
            summary.kept += kept;
            summary.fetched++;
          } catch (err) {
            recordError(p, need, err);
            summary.errors.push(`${p.label} · ${need}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
          }
        })
      )
    );
    return summary;
  }

  // Full refresh of every need, then retire live listings that haven't shown
  // up for a while (unless staff edited or verified them).
  async function syncAll() {
    const summary = await refreshNeeds(Object.keys(NEED_KEYWORDS), { force: true });
    if (!summary.errors.length) {
      summary.retired = db
        .prepare(
          `UPDATE resources SET active = 0, updated_at = datetime('now')
            WHERE source LIKE 'live:%' AND active = 1 AND edited = 0 AND last_verified IS NULL
              AND (live_seen_at IS NULL OR live_seen_at < datetime('now', ?))`
        )
        .run(`-${STALE_DAYS} days`).changes;
    }
    return summary;
  }

  function status() {
    const counts = db
      .prepare("SELECT source, COUNT(*) AS n, SUM(active) AS active, MAX(live_seen_at) AS last_seen FROM resources WHERE source LIKE 'live:%' GROUP BY source")
      .all();
    const queries = db.prepare('SELECT * FROM live_queries ORDER BY provider, need').all();
    return {
      enabled: providers.length > 0,
      center,
      radiusMiles,
      cacheHours,
      providers: providers.map((p) => {
        const q = queries.filter((x) => x.provider === p.id);
        const c = counts.find((x) => x.source === `live:${p.id}`) || {};
        return {
          id: p.id,
          label: p.label,
          listings: c.n || 0,
          active: c.active || 0,
          lastSeen: c.last_seen || null,
          lastFetch: q.reduce((m, x) => (x.fetched_at > m ? x.fetched_at : m), '') || null,
          errors: q.filter((x) => !x.ok).map((x) => ({ need: x.need, error: x.error, at: x.fetched_at })),
        };
      }),
    };
  }

  return { refreshNeeds, syncAll, status, enabled: providers.length > 0, inAccessArea };
}

module.exports = {
  createLive,
  providersFromEnv,
  hsdsProvider,
  ndpProvider,
  milesBetween,
  NEED_KEYWORDS,
  ACCESS_COUNTIES,
  DEFAULT_CENTER,
  DEFAULT_RADIUS_MILES,
};
