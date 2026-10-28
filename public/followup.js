'use strict';

(async function () {
  const T = await loadTaxonomy();
  const form = document.getElementById('lookup');
  const codeInput = document.getElementById('code');
  const list = document.getElementById('referrals');
  const errBox = document.getElementById('lookupError');
  // Youth only pick from the outcomes that make sense to self-report.
  const YOUTH_STATUSES = ['contacted', 'waitlisted', 'received', 'not_eligible', 'no_response', 'declined'];
  let code = null;

  function outcomeForm(ref) {
    const name = `s-${ref.id}`;
    const msg = el('div', { 'aria-live': 'polite' });
    const f = el('form', { class: 'no-print' },
      el('fieldset', {},
        el('legend', {}, 'What happened?'),
        el('div', { class: 'chips', role: 'radiogroup' },
          YOUTH_STATUSES.map((s) =>
            el('label', { class: 'chip' },
              el('input', { type: 'radio', name, value: s, checked: ref.status === s }),
              T.label.OUTCOMES[s])))),
      el('fieldset', {},
        el('legend', {}, 'Did anything get in the way?'),
        el('p', { class: 'hint' }, 'Pick all that apply.'),
        el('div', { class: 'chips' },
          T.BARRIERS.map((b) =>
            el('label', { class: 'chip' },
              el('input', { type: 'checkbox', name: 'barriers', value: b.id, checked: ref.barriers.includes(b.id) }),
              b.label)))),
      el('label', { class: 'label', for: `n-${ref.id}` }, 'Anything else? (optional)'),
      el('textarea', { id: `n-${ref.id}`, name: 'note', maxlength: 1000 }),
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'submit' }, 'Save'), msg));

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const status = fd.get(name);
      if (!status) return mount(msg, el('span', { class: 'errors' }, 'Pick what happened first.'));
      try {
        await api(`/api/followup/${encodeURIComponent(code)}/referrals/${ref.id}`, {
          method: 'POST',
          body: { status, barriers: fd.getAll('barriers'), note: fd.get('note') || null },
        });
        mount(msg, el('span', { class: 'success' }, 'Saved — thank you!'));
      } catch (err) {
        mount(msg, errorBox(err));
      }
    });
    return f;
  }

  function refreshPanel() {
    const msg = el('div', { 'aria-live': 'polite' });
    const needs = el('div', { class: 'chips' },
      T.NEEDS.map((n) => el('label', { class: 'chip' }, el('input', { type: 'checkbox', value: n.id }), n.label)));
    const btn = el('button', { class: 'btn', type: 'button' }, 'Refresh my matches');
    btn.addEventListener('click', async () => {
      const picked = [...needs.querySelectorAll('input:checked')].map((i) => i.value);
      btn.disabled = true;
      try {
        const res = await api(`/api/followup/${encodeURIComponent(code)}/refresh`, {
          method: 'POST',
          body: picked.length ? { needs: picked } : {},
        });
        renderResults(document.getElementById('refreshed'), res, T, { refreshed: true });
        mount(msg);
        await lookup(code, { keepResults: true });
        document.getElementById('refreshed').scrollIntoView();
      } catch (err) {
        mount(msg, errorBox(err));
      } finally {
        btn.disabled = false;
      }
    });
    return el('section', { class: 'card no-print' },
      el('h2', {}, 'Need more options?'),
      el('p', {}, 'Programs and openings change. Refresh to search again with the newest list — we’ll also use what other young people said worked.'),
      el('details', {}, el('summary', {}, 'Change what I need help with (optional)'), needs),
      el('div', { class: 'actions' }, btn, msg));
  }

  function render(data) {
    const byNeed = new Map();
    for (const r of data.referrals) {
      if (!byNeed.has(r.need)) byNeed.set(r.need, []);
      byNeed.get(r.need).push(r);
    }
    mount(list,
      refreshPanel(),
      el('h2', {}, 'Programs we suggested'),
      el('p', { class: 'muted' }, `Code ${data.refCode} · first searched ${fmtDate(data.createdAt)} · ${data.referrals.length} programs`),
      [...byNeed].map(([need, refs]) =>
        el('section', { class: 'need-group' },
          el('h2', {}, T.label.NEEDS[need] || need),
          refs.map((r) =>
            el('details', { class: 'card' },
              el('summary', {},
                el('strong', {}, r.name), ' ',
                el('span', { class: r.status === 'received' ? 'badge' : 'badge warn' }, T.label.OUTCOMES[r.status] || r.status),
                r.validated_at ? el('span', { class: 'badge' }, ' ✓ Confirmed by staff') : null),
              contactLine(r),
              outcomeForm(r)))))
    );
  }

  async function lookup(c, { keepResults = false } = {}) {
    mount(errBox);
    if (!keepResults) mount(document.getElementById('refreshed'));
    try {
      const data = await api(`/api/followup/${encodeURIComponent(c)}`);
      code = data.refCode;
      render(data);
    } catch (err) {
      mount(list);
      mount(errBox, errorBox(err));
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup(codeInput.value.trim());
  });

  const initial = new URLSearchParams(location.search).get('code');
  if (initial) {
    codeInput.value = initial;
    // Keep the code out of the address bar / history once it's been read.
    history.replaceState(null, '', '/followup');
    lookup(initial);
  }
})();
