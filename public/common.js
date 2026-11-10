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
  const init = {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  };
  // The phone app answers requests on the device (see mobile/shell.js).
  const res = window.LOCAL_API ? await window.LOCAL_API(path, init) : await fetch(path, init);
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
      if (Array.isArray(list) && typeof list[0] === 'object') t.label[key] = Object.fromEntries(list.map((x) => [x.id, x.label]));
    }
    t.label.COUNTIES[t.ACCESS_AREA.id] = t.ACCESS_AREA.label;
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
    String(r.source || '').startsWith('live:') && el('span', { class: 'badge live' }, `Live · ${r.live_provider || 'directory'}`),
    f.includes('partner') && el('span', { class: 'badge partner' }, '★ Partner'),
    f.includes('confidential') && el('span', { class: 'badge' }, 'Confidential'),
    !!(f.includes('culturally_specific') || r.culturally_specific?.length) && el('span', { class: 'badge' }, 'Culturally specific'),
    f.includes('lgbtq_affirming') && el('span', { class: 'badge' }, 'LGBTQIA2S+ affirming'),
  ];
}

let configPromise;
function loadConfig() {
  configPromise ||= api('/api/config').catch(() => ({ referralEmail: 'ripchoom@gmail.com', emailEnabled: false }));
  return configPromise;
}

// ---------- "Refer me" ----------
// target: { resource_id?, program_name?, need?, ref_code? }
function referButton(target, label = 'Refer me') {
  return el('button', { class: 'btn small refer-btn no-print', type: 'button', onclick: () => openReferDialog(target) }, `🤝 ${label}`);
}

function openReferDialog(target = {}) {
  let dlg = document.getElementById('referDialog');
  if (!dlg) {
    dlg = el('dialog', { id: 'referDialog', class: 'refer-dialog', 'aria-labelledby': 'referTitle' });
    document.body.append(dlg);
  }
  const staffMode = new URLSearchParams(location.search).get('staff') === '1';
  const errs = el('div', { 'aria-live': 'polite' });
  const age = el('input', { type: 'number', name: 'age', id: 'r-age', min: 5, max: 120, inputmode: 'numeric' });
  const adultRow = el('label', { class: 'chip hidden', id: 'r-adult-row' }, el('input', { type: 'checkbox', name: 'adult_helper' }), 'A trusted adult or staff member is helping me send this');
  age.addEventListener('input', () => adultRow.classList.toggle('hidden', !(Number(age.value) > 0 && Number(age.value) < 13)));
  const method = el('select', { name: 'contact_method', id: 'r-method', required: true },
    el('option', { value: 'text' }, 'Text me'), el('option', { value: 'call' }, 'Call me'), el('option', { value: 'email' }, 'Email me'));
  const value = el('input', { type: 'text', name: 'contact_value', id: 'r-value', autocomplete: 'off', required: true, maxlength: 120 });
  method.addEventListener('change', () => (value.inputMode = method.value === 'email' ? 'email' : 'tel'));
  value.inputMode = 'tel';
  const submit = el('button', { class: 'btn', type: 'submit' }, 'Send to staff');

  const form = el('form', { novalidate: true },
    el('div', { class: 'actions' }, el('h2', { id: 'referTitle' }, 'Refer me'),
      el('button', { class: 'btn secondary small', type: 'button', onclick: () => dlg.close() }, 'Close')),
    el('p', {}, target.program_name || target.resource_name
      ? ['Ask our staff to help you connect with ', el('strong', {}, target.resource_name || target.program_name), '.']
      : 'Ask our staff to reach out and help you find the right program.'),
    el('p', { class: 'hint' }, 'Staff will try to contact you, usually within a few business days. This is a request, not a guarantee of services. In an emergency call 911, or call/text 988.'),
    errs,
    el('div', { class: 'row' },
      el('div', {}, el('label', { class: 'label', for: 'r-name' }, 'First name or nickname (optional)'),
        el('input', { type: 'text', name: 'first_name', id: 'r-name', maxlength: 40, autocomplete: 'off' })),
      el('div', {}, el('label', { class: 'label', for: 'r-age' }, 'Age (optional)'), age)),
    adultRow,
    el('div', { class: 'row' },
      el('div', {}, el('label', { class: 'label', for: 'r-method' }, 'How should we reach you? *'), method),
      el('div', {}, el('label', { class: 'label', for: 'r-value' }, 'Phone number or email *'), value)),
    el('p', { class: 'hint' }, 'Only share a number or email that is safe for us to use.'),
    el('label', { class: 'chip' }, el('input', { type: 'checkbox', name: 'safe_to_message' }), 'It’s safe to leave a message or voicemail'),
    el('br'), el('br'),
    el('label', { class: 'label', for: 'r-time' }, 'Best time to reach you (optional)'),
    el('input', { type: 'text', name: 'best_time', id: 'r-time', maxlength: 100, placeholder: 'e.g. after 3pm, weekdays' }),
    el('label', { class: 'label', for: 'r-note' }, 'Anything staff should know? (optional)'),
    el('textarea', { name: 'note', id: 'r-note', maxlength: 1000 }),
    // Honeypot: hidden from people, filled in by bots.
    el('div', { class: 'hp', 'aria-hidden': 'true' }, el('label', {}, 'Website', el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' }))),
    el('label', { class: 'chip consent' }, el('input', { type: 'checkbox', name: 'consent' }),
      el('span', {}, 'I agree to share this with Bridge Out of Poverty staff so they can contact me. I’ve read the ',
        el('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy'), ' and understand there is ',
        el('a', { href: '/disclaimer', target: '_blank', rel: 'noopener' }, 'no guarantee of services'), '. *')),
    el('div', { class: 'actions' }, el('span'), submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {
      resource_id: target.resource_id || null,
      program_name: target.program_name || null,
      need: target.need || null,
      ref_code: target.ref_code || null,
      first_name: fd.get('first_name') || null,
      age: fd.get('age') ? Number(fd.get('age')) : null,
      contact_method: fd.get('contact_method'),
      contact_value: (fd.get('contact_value') || '').trim(),
      safe_to_message: fd.get('safe_to_message') === 'on',
      best_time: fd.get('best_time') || null,
      note: fd.get('note') || null,
      adult_helper: fd.get('adult_helper') === 'on',
      consent: fd.get('consent') === 'on',
      website: fd.get('website') || '',
    };
    if (!body.consent) return mount(errs, el('div', { class: 'errors' }, 'Please check the box to agree before sending.'));
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const res = await api('/api/refer', { method: 'POST', body, headers: staffMode ? { 'X-Intake-Source': 'staff' } : {} });
      const cfg = await loadConfig();
      const program = target.resource_name || target.program_name || 'general help';
      const mail = `mailto:${cfg.referralEmail}?subject=${encodeURIComponent(`Refer me #${res.id || ''}: ${program}`)}&body=${encodeURIComponent(
        `Please help me connect with: ${program}\nReach me by ${body.contact_method}: ${body.contact_value}\nOK to leave a message: ${body.safe_to_message ? 'yes' : 'NO'}\nBest time: ${body.best_time || 'any'}\n${body.note || ''}`)}`;
      mount(form,
        el('div', { class: 'actions' }, el('h2', {}, 'Request sent ✓'), el('button', { class: 'btn secondary small', type: 'button', onclick: () => dlg.close() }, 'Close')),
        el('p', {}, 'Thank you. Our staff have your request', res.id ? ` (#${res.id})` : '', ' and will try to reach you the way you asked.'),
        el('p', { class: 'hint' }, 'Keep looking in the meantime — apply to other programs too. If you’re not safe right now, call 911 or call/text 988.'),
        res.emailed ? null : el('p', { class: 'small' },
          'Want to be extra sure? You can also ',
          el('a', { href: mail }, 'email this request to our staff'),
          ' from your own email app (only if that email account is safe for you to use).'));
    } catch (err) {
      mount(errs, errorBox(err));
      submit.disabled = false;
      submit.textContent = 'Send to staff';
    }
  });

  mount(dlg, el('div', { class: 'card' }, form));
  dlg.showModal();
  form.querySelector('#r-name').focus();
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
    r.live_miles != null ? el('p', { class: 'small muted' }, `About ${r.live_miles} miles from downtown Portland`) : null,
    r.eligibility ? el('p', { class: 'small muted' }, `Who qualifies: ${r.eligibility}`) : null,
    m.reasons.length ? el('ul', { class: 'reasons' }, m.reasons.map((x) => el('li', {}, x))) : null,
    m.alsoHelpsWith.length ? el('p', { class: 'small muted' }, `Also helps with: ${m.alsoHelpsWith.join(', ')}`) : null,
    m.warnings.length ? el('ul', { class: 'warnings' }, m.warnings.map((x) => el('li', {}, x))) : null,
    r.crisis ? null : el('div', { class: 'actions' }, el('span'), referButton({ resource_id: r.id, resource_name: r.name, need: m.need || null })));
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
                : (shown.add(m.resource.id), resourceCard({ ...m, need: g.need })))
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

// Footer with the legal links on every page.
function siteFooter() {
  return el('footer', { class: 'site-footer no-print' },
    el('nav', { 'aria-label': 'Legal' },
      el('a', { href: '/privacy' }, 'Privacy Policy'),
      el('a', { href: '/terms' }, 'Terms of Use'),
      el('a', { href: '/disclaimer' }, 'No Guarantee of Services'),
      el('a', { href: '/security' }, 'Security')),
    el('p', {}, 'Bridge Out of Poverty is an information and referral tool. It does not guarantee housing, benefits or services. Emergencies: 911 · Crisis: call or text 988 · Help finding services: 211.'));
}

document.addEventListener('DOMContentLoaded', () => {
  if (!document.querySelector('.site-footer')) document.body.append(siteFooter());
  for (const b of document.querySelectorAll('.quick-exit')) b.addEventListener('click', quickExit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.shiftKey) quickExit();
  });
});
