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
