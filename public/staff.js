'use strict';

(async function () {
  const T = await loadTaxonomy();
  const $ = (id) => document.getElementById(id);
  const dialog = $('dialog');
  const dialogBody = $('dialogBody');
  const SMALL_CELL = 5;

  // ---------- Auth ----------
  async function boot() {
    const { staff } = await api('/api/staff/me');
    $('login').classList.toggle('hidden', staff);
    $('app').classList.toggle('hidden', !staff);
    $('logout').classList.toggle('hidden', !staff);
    if (staff) showTab('dashboard');
    else $('password').focus();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    mount($('loginError'));
    try {
      await api('/api/staff/login', { method: 'POST', body: { password: $('password').value } });
      $('password').value = '';
      boot();
    } catch (err) {
      mount($('loginError'), errorBox(err));
    }
  });

  $('logout').addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/staff/logout', { method: 'POST', body: {} });
    boot();
  });

  // ---------- Tabs ----------
  const loaders = { dashboard: loadDashboard, clients: loadClients, resources: loadResources };
  function showTab(name) {
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const k of Object.keys(loaders)) $(`tab-${k}`).classList.toggle('hidden', k !== name);
    loaders[name]().catch(handleError);
  }
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

  function handleError(err) {
    if (err.status === 401) return boot();
    alert(err.message);
  }

  function openDialog(...children) {
    mount(dialogBody,
      el('div', { class: 'actions no-print' }, el('span'), el('button', { class: 'btn secondary small', type: 'button', onclick: () => dialog.close() }, 'Close')),
      ...children
    );
    dialog.showModal();
  }

  // ---------- Dashboard ----------
  const dashState = { from: '', to: '', county: '', suppress: true };

  function bars(obj, labels = {}, { alt = false, limit = 20 } = {}) {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit);
    if (!entries.length) return el('p', { class: 'muted small' }, 'No data yet.');
    const max = Math.max(...entries.map(([, n]) => n));
    return el('div', { class: 'bars' },
      entries.map(([k, n]) => {
        const hidden = dashState.suppress && n < SMALL_CELL;
        const fill = el('div', { class: 'fill' });
        fill.style.width = `${hidden ? 0 : (n / max) * 100}%`;
        return el('div', { class: `bar${alt ? ' alt' : ''}` },
          el('span', {}, labels[k] || k),
          el('div', { class: 'track' }, fill),
          el('span', { class: 'n' }, hidden ? `<${SMALL_CELL}` : n));
      }));
  }

  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const rate = (o) => (o.finals ? o.received / o.finals : null);
  const topBarriers = (b) =>
    Object.entries(b || {}).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${T.label.BARRIERS[k] || k} (${n})`).join(', ') || '—';

  function panel(title, hint, body) {
    return el('section', { class: 'card' }, el('h3', {}, title), hint && el('p', { class: 'hint' }, hint), body);
  }

  async function loadDashboard() {
    const qs = new URLSearchParams(Object.entries({ from: dashState.from, to: dashState.to, county: dashState.county }).filter(([, v]) => v));
    const d = await api(`/api/staff/dashboard?${qs}`);
    const t = d.totals;
    const groupLabels = {
      age: 'Age', lgbtq: 'LGBTQIA2S+', race: 'Race / ethnicity', housing: 'Housing', foster: 'Foster care', county: 'County',
    };
    const groupKeyLabel = (g, k) => (g === 'race' ? T.label.RACE[k] : g === 'county' ? T.label.COUNTIES[k]?.split(' (')[0] : null) || k;

    const filters = el('div', { class: 'card toolbar no-print' },
      el('label', {}, 'From', el('input', { type: 'date', value: dashState.from, onchange: (e) => ((dashState.from = e.target.value), loadDashboard()) })),
      el('label', {}, 'To', el('input', { type: 'date', value: dashState.to, onchange: (e) => ((dashState.to = e.target.value), loadDashboard()) })),
      el('label', {}, 'County',
        el('select', { onchange: (e) => ((dashState.county = e.target.value), loadDashboard()) },
          el('option', { value: '' }, 'All'),
          T.COUNTIES.map((c) => el('option', { value: c.id, selected: dashState.county === c.id }, c.label.split(' (')[0])))),
      el('label', { class: 'chip' },
        el('input', { type: 'checkbox', checked: dashState.suppress, onchange: (e) => ((dashState.suppress = e.target.checked), loadDashboard()) }),
        `Hide counts under ${SMALL_CELL} (for sharing)`),
      el('a', { class: 'btn secondary small', href: '/api/staff/export/referrals.csv' }, 'Export de-identified CSV'),
      el('a', { class: 'btn secondary small', href: '/api/staff/export/resources.json' }, 'Export resources'));

    const stat = (v, k) => el('div', { class: 'stat' }, el('div', { class: 'v' }, v), el('div', { class: 'k' }, k));

    mount($('tab-dashboard'),
      filters,
      el('div', { class: 'stats' },
        stat(t.clients, 'Youth served'),
        stat(t.searches, 'Searches'),
        stat(t.referrals, 'Programs suggested'),
        stat(t.clientsFollowedUp, 'Youth who reported back'),
        stat(pct(t.successRate), `Got help (of ${t.outcomesReported} outcomes)`),
        stat(t.validated, 'Connections confirmed by staff'),
        stat(t.withUnmetNeed, 'Searches with an unmet need'),
        stat(t.confidential, 'Private searches')),
      el('div', { class: 'grid2' },
        panel('What youth are asking for', 'Needs selected or implied per search.', bars(d.needs, T.label.NEEDS)),
        panel('Gaps: needs with no specific program', 'Logged when only a general line (211) matched.', bars(d.unmet, T.label.NEEDS, { alt: true })),
        panel('Barriers reported', 'From youth check-ins and staff updates.', bars(d.barriers, T.label.BARRIERS, { alt: true })),
        panel('Referral outcomes', null, bars(d.outcomes, T.label.OUTCOMES)),
        panel('Searches per week', null, bars(Object.fromEntries(d.weekly), {}, { limit: 26 }))),
      panel('Success & barriers by group', 'Compare who is getting help. Success = “Got help” ÷ reported final outcomes.',
        el('div', { class: 'grid2' },
          Object.entries(d.byGroup).map(([g, rows]) =>
            el('div', { class: 'table-wrap' },
              el('h3', {}, groupLabels[g] || g),
              el('table', {},
                el('thead', {}, el('tr', {}, el('th', {}, 'Group'), el('th', {}, 'Suggested'), el('th', {}, 'Success'), el('th', {}, 'Top barriers'))),
                el('tbody', {},
                  Object.entries(rows).sort((a, b) => b[1].referrals - a[1].referrals).map(([k, o]) =>
                    el('tr', {},
                      el('td', {}, groupKeyLabel(g, k)),
                      el('td', {}, dashState.suppress && o.referrals < SMALL_CELL ? `<${SMALL_CELL}` : o.referrals),
                      el('td', {}, dashState.suppress && o.finals < SMALL_CELL ? '—' : pct(rate(o))),
                      el('td', { class: 'small' }, topBarriers(o.barriers)))))))))),
      panel('Programs', 'Which programs youth are sent to and what happens.',
        el('div', { class: 'table-wrap' },
          el('table', {},
            el('thead', {}, el('tr', {}, ['Program', 'Suggested', 'Updated', 'Got help', 'Confirmed', 'Success', 'Top barriers'].map((h) => el('th', {}, h)))),
            el('tbody', {},
              d.byResource.map((r) =>
                el('tr', {},
                  el('td', {}, r.name), el('td', {}, r.referrals), el('td', {}, r.updated), el('td', {}, r.received), el('td', {}, r.validated),
                  el('td', {}, pct(rate(r))), el('td', { class: 'small' }, topBarriers(r.barriers)))))))),
      el('h2', {}, 'Who we’re serving'),
      el('div', { class: 'grid2' },
        panel('Age', null, bars(d.demographics.age)),
        panel('County', null, bars(d.demographics.county, T.label.COUNTIES)),
        panel('Race / ethnicity', 'People can pick more than one.', bars(d.demographics.race, T.label.RACE)),
        panel('Gender identity', null, bars(d.demographics.gender, T.label.GENDER)),
        panel('LGBTQIA2S+', null, bars(d.demographics.lgbtq, T.label.LGBTQ)),
        panel('Housing', null, bars(d.demographics.housing, T.label.HOUSING)),
        panel('Income', null, bars(d.demographics.income, T.label.INCOME)),
        panel('Family', null, bars(d.demographics.family, T.label.FAMILY)),
        panel('Education', null, bars(d.demographics.education, T.label.EDUCATION)),
        panel('Employment', null, bars(d.demographics.employment, T.label.EMPLOYMENT)),
        panel('Vulnerabilities', null, bars(d.demographics.vulnerabilities, T.label.VULNERABILITIES))));
  }

  // ---------- Clients ----------
  async function loadClients(q = '') {
    const rows = await api(`/api/staff/clients?${new URLSearchParams(q ? { q } : {})}`);
    const search = el('input', { type: 'search', placeholder: 'Find by code (ABCD-2345)', value: q });
    mount($('tab-clients'),
      el('form', { class: 'card toolbar', onsubmit: (e) => (e.preventDefault(), loadClients(search.value.trim()).catch(handleError)) },
        el('label', { class: 'grow' }, 'Search', search),
        el('button', { class: 'btn', type: 'submit' }, 'Find'),
        el('a', { class: 'btn secondary', href: '/?staff=1' }, 'New assisted intake')),
      el('div', { class: 'card table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, ['Code', 'Date', 'Age', 'County', 'Housing', 'Needs', 'Suggested', 'Updated', 'Got help', 'Contact OK'].map((h) => el('th', {}, h)))),
          el('tbody', {},
            rows.length
              ? rows.map((c) =>
                  el('tr', { class: 'clickable', tabindex: '0', onclick: () => openClient(c.ref_code), onkeydown: (e) => e.key === 'Enter' && openClient(c.ref_code) },
                    el('td', {}, el('code', {}, c.ref_code), c.confidential ? el('span', { class: 'badge warn' }, ' private') : null),
                    el('td', {}, fmtDate(c.created_at)),
                    el('td', {}, c.age),
                    el('td', {}, T.label.COUNTIES[c.county]?.split(' (')[0] || c.county),
                    el('td', {}, T.label.HOUSING[c.housing] || '—'),
                    el('td', { class: 'small' }, c.needs.map((n) => T.label.NEEDS[n]).join(', ')),
                    el('td', {}, c.referrals),
                    el('td', {}, c.updated),
                    el('td', {}, c.received),
                    el('td', {}, c.contact_ok ? 'Yes' : '—')))
              : el('tr', {}, el('td', { colspan: '10', class: 'muted' }, 'No youth found.'))))));
  }

  function profileList(c) {
    const one = (key, list) => T.label[list][c[key]] || '—';
    const many = (key, list) => (c[key].length ? c[key].map((x) => T.label[list][x] || x).join(', ') : '—');
    if (c.confidential)
      return el('div', {},
        el('p', { class: 'notice' }, 'Private search — the youth chose to save only age, area, language, and needs.'),
        el('table', {}, el('tbody', {},
          [['Age', c.age ?? '—'], ['County', one('county', 'COUNTIES')], ['Language', one('language', 'LANGUAGES')], ['Needs', many('needs', 'NEEDS')]]
            .map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v))))));
    const rows = [
      ['Age', c.age ?? '—'], ['County', one('county', 'COUNTIES')], ['ZIP', c.zip || '—'], ['Language', one('language', 'LANGUAGES')],
      ['Race / ethnicity', many('race', 'RACE')], ['Sex', one('sex', 'SEX')], ['Gender', many('gender', 'GENDER')],
      ['LGBTQIA2S+', one('lgbtq', 'LGBTQ')], ['Family', many('family', 'FAMILY')], ['Household size', c.household_size || '—'],
      ['Income', one('income', 'INCOME')], ['Income sources', many('income_sources', 'INCOME_SOURCES')],
      ['Housing', one('housing', 'HOUSING')], ['Education', one('education', 'EDUCATION')], ['Employment', one('employment', 'EMPLOYMENT')],
      ['Vulnerabilities', many('vulnerabilities', 'VULNERABILITIES')], ['Needs', many('needs', 'NEEDS')],
      ['Preferences', many('preferences', 'PREFERENCES')], ['Notes', c.notes || '—'],
      ['Contact', c.contact_ok ? `${c.contact_method}: ${c.contact_value}` : 'Not OK to contact'],
      ['Intake by', c.source === 'staff' ? 'Staff-assisted' : 'Self'],
    ];
    return el('table', {}, el('tbody', {}, rows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v)))));
  }

  function staffOutcomeForm(ref, onSaved) {
    const status = el('select', {}, T.OUTCOMES.map((o) => el('option', { value: o.id, selected: ref.status === o.id }, o.label)));
    const barrierBoxes = T.BARRIERS.map((b) => el('input', { type: 'checkbox', value: b.id, checked: ref.barriers.includes(b.id) }));
    const note = el('input', { type: 'text', placeholder: 'Note (optional)', maxlength: 1000 });
    const msg = el('span', { 'aria-live': 'polite' });
    return el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api(`/api/staff/referrals/${ref.id}`, {
            method: 'POST',
            body: { status: status.value, barriers: barrierBoxes.filter((b) => b.checked).map((b) => b.value), note: note.value || null },
          });
          mount(msg, el('span', { class: 'success' }, 'Saved'));
          onSaved();
        } catch (err) {
          mount(msg, errorBox(err));
        }
      },
    },
    el('div', { class: 'toolbar' }, el('label', {}, 'Status', status), el('label', { class: 'grow' }, 'Note', note)),
    el('div', { class: 'chips' }, T.BARRIERS.map((b, i) => el('label', { class: 'chip' }, barrierBoxes[i], b.label))),
    el('div', { class: 'actions' }, el('button', { class: 'btn small', type: 'submit' }, 'Save update'), msg));
  }

  // Validating = staff confirmed with the provider that the youth was really
  // connected. It counts extra in future matching.
  function validationBox(ref, onSaved) {
    if (ref.validated_at)
      return el('p', { class: 'success' },
        `✓ Connection confirmed by ${ref.validated_by} on ${fmtDate(ref.validated_at)}`,
        ref.validation_note ? ` — “${ref.validation_note}”` : '', ' ',
        el('button', {
          class: 'btn secondary small', type: 'button',
          onclick: async () => {
            await api(`/api/staff/referrals/${ref.id}/unvalidate`, { method: 'POST', body: {} }).catch(handleError);
            onSaved();
          },
        }, 'Undo'));
    const who = el('input', { type: 'text', placeholder: 'Your initials', maxlength: 100 });
    const note = el('input', { type: 'text', placeholder: 'How you confirmed (e.g. called intake)', maxlength: 1000 });
    const msg = el('span');
    return el('div', { class: 'toolbar validate' },
      el('label', {}, 'Confirmed by', who),
      el('label', { class: 'grow' }, 'Note', note),
      el('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          try {
            await api(`/api/staff/referrals/${ref.id}/validate`, { method: 'POST', body: { verified_by: who.value, note: note.value || null } });
            onSaved();
          } catch (err) {
            mount(msg, errorBox(err));
          }
        },
      }, '✓ Validate connection'),
      msg);
  }

  async function openClient(code, openId = null) {
    try {
      const { client, referrals, events } = await api(`/api/staff/clients/${encodeURIComponent(code)}`);
      const reload = (id) => () => openClient(code, id);
      openDialog(
        el('h2', {}, 'Youth ', el('code', {}, client.ref_code)),
        el('p', { class: 'muted small' }, `Intake ${fmtDate(client.created_at)}`),
        el('details', {}, el('summary', {}, 'Intake answers'), el('div', { class: 'table-wrap' }, profileList(client))),
        el('h3', {}, 'Referrals'),
        referrals.map((r) =>
          el('details', { class: 'card', open: r.id === openId },
            el('summary', {}, el('strong', {}, r.name), ' — ', T.label.NEEDS[r.need] || r.need, ' ',
              el('span', { class: 'badge' }, T.label.OUTCOMES[r.status])),
            contactLine(r),
            validationBox(r, reload(r.id)),
            staffOutcomeForm(r, reload(r.id)))),
        el('h3', {}, 'History'),
        events.length
          ? el('ul', { class: 'small' }, events.map((e) => {
              const ref = referrals.find((r) => r.id === e.referral_id);
              return el('li', {}, `${fmtDate(e.created_at)} · ${e.reported_by} · ${ref?.name || ''}: ${T.label.OUTCOMES[e.status]}`,
                e.barriers.length ? ` (barriers: ${e.barriers.map((b) => T.label.BARRIERS[b]).join(', ')})` : '',
                e.note ? ` — “${e.note}”` : '');
            }))
          : el('p', { class: 'muted small' }, 'No updates yet.'),
        el('div', { class: 'actions' },
          el('span'),
          el('button', {
            class: 'btn danger small', type: 'button',
            onclick: async () => {
              if (!confirm(`Permanently delete all data for ${client.ref_code}? This cannot be undone.`)) return;
              await api(`/api/staff/clients/${encodeURIComponent(client.ref_code)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
              dialog.close();
              loadClients().catch(handleError);
            },
          }, 'Delete this youth’s data')));
    } catch (err) {
      handleError(err);
    }
  }

  // ---------- Resources ----------
  const STALE_DAYS = 180;
  const isStale = (r) => !r.last_verified || (Date.now() - Date.parse(r.last_verified)) / 86400000 > STALE_DAYS;
  let resFilter = { q: '', stale: false, inactive: false };

  let allResources = [];
  async function loadResources() {
    allResources = await api('/api/staff/resources');
    renderResources();
  }

  function resourceRows() {
    const shown = allResources.filter(
      (r) =>
        (!resFilter.q || `${r.name} ${r.org || ''}`.toLowerCase().includes(resFilter.q.toLowerCase())) &&
        (!resFilter.stale || isStale(r)) &&
        (resFilter.inactive || r.active)
    );
    return shown.map((r) =>
      el('tr', {},
        el('td', {}, el('strong', {}, r.name), ' ', resourceBadges(r), r.active ? '' : el('span', { class: 'badge warn' }, 'inactive')),
        el('td', { class: 'small' }, r.categories.map((c) => T.label.NEEDS[c] || c).join(', ')),
        el('td', { class: 'small' }, r.counties.includes('all') ? 'Anywhere' : r.counties.map((c) => T.label.COUNTIES[c]?.split(' (')[0] || c).join(', ')),
        el('td', {}, `${r.age_min}–${r.age_max}`),
        el('td', {}, isStale(r) ? el('span', { class: 'badge warn' }, r.last_verified ? fmtDate(r.last_verified) : 'Never') : fmtDate(r.last_verified)),
        el('td', { class: 'small' },
          !r.link_status ? '—' : r.link_status === 'ok' ? '✓ loads' : el('span', { class: 'badge warn' }, r.link_status)),
        el('td', {}, r.stats ? `${r.stats.referrals} → ${r.stats.successes} (${r.stats.validated} ✓)` : '—'),
        el('td', {},
          el('div', { class: 'chips' },
            el('button', { class: 'btn secondary small', type: 'button', onclick: () => editResource(r) }, 'Edit'),
            el('button', {
              class: 'btn secondary small', type: 'button', title: 'Partner programs are favored in matching',
              onclick: async () => {
                try {
                  await api(`/api/staff/resources/${encodeURIComponent(r.id)}/partner`, { method: 'POST', body: { partner: !r.flags.includes('partner') } });
                  loadResources();
                } catch (err) {
                  handleError(err);
                }
              },
            }, r.flags.includes('partner') ? '★ Unfavor' : '☆ Favor'),
            el('button', {
              class: 'btn small', type: 'button',
              onclick: async () => {
                const who = prompt('Your name or initials (for the record):', '');
                if (who === null) return;
                try {
                  await api(`/api/staff/resources/${encodeURIComponent(r.id)}/verify`, { method: 'POST', body: { verified_by: who } });
                  loadResources();
                } catch (err) {
                  handleError(err);
                }
              },
            }, 'Verified')))));
  }

  function renderResources() {
    const all = allResources;
    const tbody = el('tbody', {}, resourceRows());
    const rerows = () => mount(tbody, resourceRows());
    const status = el('div', { 'aria-live': 'polite' });
    const updateExisting = el('input', { type: 'checkbox' });
    const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'hidden' });
    const busy = async (label, fn) => {
      mount(status, el('p', { class: 'muted' }, `${label}…`));
      try {
        mount(status, el('div', { class: 'notice' }, await fn()));
        allResources = await api('/api/staff/resources');
        mount(tbody, resourceRows());
      } catch (err) {
        if (err.status === 401) return handleError(err);
        mount(status, errorBox(err));
      }
    };
    const mergeMsg = (r) => `${r.added} added, ${r.updated} updated, ${r.kept} kept as they were.`;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      busy('Importing', async () => {
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          throw new Error('That file isn’t valid JSON.');
        }
        const list = Array.isArray(parsed) ? parsed : parsed.resources;
        return `Import: ${mergeMsg(await api('/api/staff/resources/import', { method: 'POST', body: { resources: list, updateExisting: updateExisting.checked } }))}`;
      });
      fileInput.value = '';
    });
    const staleCount = all.filter((r) => r.active && isStale(r)).length;
    const brokenCount = all.filter((r) => r.active && r.link_status && r.link_status !== 'ok').length;
    mount($('tab-resources'),
      el('section', { class: 'card' },
        el('h3', {}, 'Keep the directory fresh'),
        el('p', { class: 'hint' }, 'Refresh adds programs from the built-in starter list that you don’t have yet. Import adds programs from a JSON file (same format as “Export resources”). Programs you have edited or verified are never overwritten.'),
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn secondary', type: 'button', onclick: () => busy('Refreshing', async () => `Refresh: ${mergeMsg(await api('/api/staff/resources/refresh', { method: 'POST', body: { updateExisting: updateExisting.checked } }))}`) }, '↻ Refresh from starter list'),
          el('button', { class: 'btn secondary', type: 'button', onclick: () => fileInput.click() }, 'Import JSON…'),
          fileInput,
          el('button', {
            class: 'btn secondary', type: 'button',
            onclick: () => busy('Checking websites (this can take a minute)', async () => {
              const r = await api('/api/staff/resources/check-links', { method: 'POST', body: {} });
              return `Checked ${r.checked} websites: ${r.ok} loaded, ${r.broken.length} need a look${r.broken.length ? ` (${r.broken.map((b) => b.id).join(', ')})` : ''}.`;
            }),
          }, 'Check websites'),
          el('label', { class: 'chip' }, updateExisting, 'Also update programs nobody has edited or verified')),
        status),
      staleCount ? el('div', { class: 'notice' }, `${staleCount} active programs haven’t been verified in the last ${STALE_DAYS} days. Call or check their website, update details, then click “Verified”.`) : null,
      brokenCount ? el('div', { class: 'notice' }, `${brokenCount} program websites didn’t load at the last check.`) : null,
      el('div', { class: 'card toolbar' },
        el('label', { class: 'grow' }, 'Search', el('input', { type: 'search', value: resFilter.q, oninput: (e) => ((resFilter.q = e.target.value), rerows()) })),
        el('label', { class: 'chip' }, el('input', { type: 'checkbox', checked: resFilter.stale, onchange: (e) => ((resFilter.stale = e.target.checked), rerows()) }), 'Needs verification'),
        el('label', { class: 'chip' }, el('input', { type: 'checkbox', checked: resFilter.inactive, onchange: (e) => ((resFilter.inactive = e.target.checked), rerows()) }), 'Show inactive'),
        el('button', { class: 'btn', type: 'button', onclick: () => editResource(null) }, 'Add program')),
      el('div', { class: 'card table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, ['Program', 'Helps with', 'Area', 'Ages', 'Verified', 'Website', 'Suggested → got help (✓ confirmed)', ''].map((h) => el('th', {}, h)))),
          tbody)));
  }

  function checkList(name, list, selected) {
    return el('div', { class: 'chips' },
      list.map((o) => el('label', { class: 'chip' }, el('input', { type: 'checkbox', name, value: o.id, checked: selected.includes(o.id) }), o.label)));
  }

  function editResource(r) {
    const v = r || { categories: [], populations: [], requires: [], counties: [], languages: ['en'], culturally_specific: [], flags: [], age_min: 9, age_max: 26, active: true };
    const input = (name, label, attrs = {}) =>
      el('label', { class: 'label' }, label, el('input', { type: 'text', name, value: v[name] ?? '', ...attrs }));
    const errs = el('div');
    const counties = [{ id: 'all', label: 'Anywhere (statewide / national)' }, ...T.COUNTIES];
    const flagOptions = [...T.RESOURCE_FLAGS, ...T.PREFERENCES];
    const form = el('form', {},
      el('h2', {}, r ? `Edit ${r.name}` : 'Add a program'),
      errs,
      el('div', { class: 'row' }, input('name', 'Name *', { required: true }), input('org', 'Organization')),
      el('label', { class: 'label' }, 'Description', el('textarea', { name: 'description' }, v.description || '')),
      el('div', { class: 'row' }, input('phone', 'Phone'), input('text', 'Text / chat'), input('website', 'Website (https://…)')),
      el('div', { class: 'row' }, input('address', 'Address'), input('hours', 'Hours')),
      el('label', { class: 'label' }, 'Who qualifies', el('textarea', { name: 'eligibility' }, v.eligibility || '')),
      el('div', { class: 'row' },
        input('age_min', 'Youngest age served', { type: 'number', min: 0, max: 120 }),
        input('age_max', 'Oldest age served', { type: 'number', min: 0, max: 120 })),
      el('br'),
      field('Helps with *', checkList('categories', T.NEEDS, v.categories)),
      field('Areas served *', checkList('counties', counties, v.counties)),
      field('Focus populations (boost in matching)', checkList('populations', T.POPULATIONS, v.populations)),
      field('Only for (youth must match at least one)', checkList('requires', T.POPULATIONS, v.requires)),
      field('Culturally specific for', checkList('culturally_specific', T.RACE.filter((x) => x.id !== 'prefer_not'), v.culturally_specific)),
      field('Languages', checkList('languages', T.LANGUAGES, v.languages)),
      field('Features', checkList('flags', flagOptions, v.flags)),
      el('div', { class: 'chips' },
        el('label', { class: 'chip' }, el('input', { type: 'checkbox', name: 'crisis', checked: v.crisis }), '24/7 crisis line'),
        el('label', { class: 'chip' }, el('input', { type: 'checkbox', name: 'active', checked: v.active }), 'Active (shown to youth)')),
      el('div', { class: 'actions' }, el('span'), el('button', { class: 'btn', type: 'submit' }, 'Save')));

    function field(legend, control) {
      return el('fieldset', {}, el('legend', {}, legend), control);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = {
        ...(r ? { id: r.id, last_verified: r.last_verified, verified_by: r.verified_by } : {}),
        crisis: fd.get('crisis') === 'on',
        active: fd.get('active') === 'on',
      };
      for (const k of ['name', 'org', 'description', 'phone', 'text', 'website', 'address', 'hours', 'eligibility', 'age_min', 'age_max'])
        body[k] = fd.get(k) || null;
      for (const k of ['categories', 'counties', 'populations', 'requires', 'culturally_specific', 'languages', 'flags']) body[k] = fd.getAll(k);
      try {
        await api('/api/staff/resources', { method: 'POST', body });
        dialog.close();
        loadResources();
      } catch (err) {
        if (err.status === 401) return handleError(err);
        mount(errs, errorBox(err));
        dialogBody.scrollTop = 0;
      }
    });
    openDialog(form);
  }

  boot().catch(handleError);
})();
