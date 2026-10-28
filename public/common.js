'use strict';

// Tiny DOM builder: el('div', { class: 'x', onclick }, child, 'text', ...).
// Children are appended as text nodes, never parsed as HTML.
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// replaceChildren that, like el(), flattens arrays and skips null/false.
function mount(node, ...children) {
  node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data.details || [];
    throw err;
  }
  return data;
}

let taxonomyPromise;
function loadTaxonomy() {
  taxonomyPromise ||= api('/api/taxonomy').then((t) => {
    t.label = {};
    for (const [key, list] of Object.entries(t)) {
      if (Array.isArray(list)) t.label[key] = Object.fromEntries(list.map((x) => [x.id, x.label]));
    }
    return t;
  });
  return taxonomyPromise;
}

function telHref(phone) {
  const digits = String(phone).replace(/[^0-9]/g, '');
  return digits ? `tel:${digits}` : null;
}

function contactLine(r) {
  return el(
    'div',
    { class: 'contact' },
    r.phone && el('a', { href: telHref(r.phone) }, `📞 ${r.phone}`),
    r.text && el('span', {}, `💬 ${r.text}`),
    r.website && el('a', { href: r.website, target: '_blank', rel: 'noopener noreferrer' }, '🌐 Website'),
    r.address && el('span', {}, `📍 ${r.address}`)
  );
}

function resourceBadges(r) {
  const f = r.flags || [];
  return [
    r.crisis && el('span', { class: 'badge crisis' }, '24/7'),
    f.includes('partner') && el('span', { class: 'badge partner' }, '★ Partner'),
    f.includes('confidential') && el('span', { class: 'badge' }, 'Confidential'),
    !!(f.includes('culturally_specific') || r.culturally_specific?.length) && el('span', { class: 'badge' }, 'Culturally specific'),
    f.includes('lgbtq_affirming') && el('span', { class: 'badge' }, 'LGBTQIA2S+ affirming'),
  ];
}

function resourceCard(m) {
  const r = m.resource;
  return el('article', { class: 'card resource' },
    el('h3', {}, r.name),
    el('div', { class: 'chips' }, resourceBadges(r)),
    r.org && r.org !== r.name ? el('div', { class: 'org' }, r.org) : null,
    el('p', {}, r.description),
    contactLine(r),
    r.hours ? el('p', { class: 'small muted' }, `Hours: ${r.hours}`) : null,
    r.eligibility ? el('p', { class: 'small muted' }, `Who qualifies: ${r.eligibility}`) : null,
    m.reasons.length ? el('ul', { class: 'reasons' }, m.reasons.map((x) => el('li', {}, x))) : null,
    m.alsoHelpsWith.length ? el('p', { class: 'small muted' }, `Also helps with: ${m.alsoHelpsWith.join(', ')}`) : null,
    m.warnings.length ? el('ul', { class: 'warnings' }, m.warnings.map((x) => el('li', {}, x))) : null);
}

// Renders match results (from a new search or a refresh) into `out`.
function renderResults(out, res, T, { refreshed = false } = {}) {
  const shown = new Set();
  const total = new Set(res.byNeed.flatMap((g) => g.matches.map((m) => m.resource.id))).size;
  mount(out,
    el('div', { class: 'card' },
      el('h1', {}, refreshed ? `Updated: ${total} program${total === 1 ? '' : 's'} for you` : `We found ${total} program${total === 1 ? '' : 's'} for you`),
      el('p', {}, 'Your check-in code:'),
      el('p', {}, el('span', { class: 'refcode' }, res.refCode)),
      el('p', { class: 'small muted' },
        'Save this code (screenshot it or write it down). Come back to ',
        el('a', { href: `/followup?code=${encodeURIComponent(res.refCode)}` }, 'Check in'),
        ' to tell us how it went or to refresh your matches — new programs are added over time.'),
      res.usedDefaults
        ? el('p', { class: 'notice' }, 'You didn’t pick a need, so we’re showing our main housing, rent, and utility help. Pick needs any time for better matches.')
        : null,
      el('div', { class: 'actions no-print' },
        el('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print / save as PDF'),
        refreshed ? null : el('a', { class: 'btn secondary', href: '/' }, 'Start over'))),

    res.crisis.length
      ? el('section', { class: 'card crisis-box' },
          el('h2', {}, 'Support right now, 24/7'),
          el('p', {}, 'You don’t have to wait. These lines are free and confidential.'),
          el('div', { class: 'crisis-list' },
            res.crisis.map((r) => el('div', { class: 'crisis-item' }, el('strong', {}, r.name), contactLine(r)))))
      : null,

    res.unmetNeeds.length
      ? el('div', { class: 'notice' },
          el('strong', {}, 'We couldn’t find a specific program for: '),
          res.unmetNeeds.map((n) => T.label.NEEDS[n]).join(', '),
          '. 211info can search more options — call 211 or text your ZIP to 898211. We’ve logged this gap so our team can work on it.')
      : null,

    res.byNeed.map((g) =>
      el('section', { class: 'need-group' },
        el('h2', {}, g.label,
          g.defaulted ? el('span', { class: 'badge' }, 'Common need')
            : g.implied ? el('span', { class: 'badge warn' }, 'Added based on your answers') : null),
        g.matches.length
          ? g.matches.map((m) =>
              shown.has(m.resource.id)
                ? el('p', { class: 'card small' }, el('strong', {}, m.resource.name), ' — listed above')
                : (shown.add(m.resource.id), resourceCard(m)))
          : el('p', { class: 'muted' }, 'No matches yet — try 211info (call 211).')))
  );
  out.classList.remove('hidden');
}

function errorBox(err) {
  return el(
    'div',
    { class: 'errors', role: 'alert' },
    el('strong', {}, err.message),
    err.details?.length ? el('ul', {}, err.details.map((d) => el('li', {}, d))) : null
  );
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.length <= 10 ? `${s}T12:00:00` : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

// Quick exit: leave immediately and replace this page in history so the back
// button does not return here.
function quickExit() {
  try {
    sessionStorage.clear();
  } catch {}
  window.location.replace('https://weather.com');
}

document.addEventListener('DOMContentLoaded', () => {
  for (const b of document.querySelectorAll('.quick-exit')) b.addEventListener('click', quickExit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.shiftKey) quickExit();
  });
});
