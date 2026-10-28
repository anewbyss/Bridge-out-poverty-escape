'use strict';

(async function () {
  const [T, resources] = await Promise.all([loadTaxonomy(), api('/api/resources')]);
  const $ = (id) => document.getElementById(id);
  $('need').append(...T.NEEDS.map((n) => el('option', { value: n.id }, n.label)));
  $('county').append(...T.COUNTIES.filter((c) => c.id !== 'other').map((c) => el('option', { value: c.id }, c.label)));

  function render() {
    const q = $('q').value.trim().toLowerCase();
    const need = $('need').value;
    const county = $('county').value;
    const age = Number($('age').value) || null;
    const shown = resources.filter(
      (r) =>
        (!q || `${r.name} ${r.org || ''} ${r.description || ''}`.toLowerCase().includes(q)) &&
        (!need || r.categories.includes(need)) &&
        (!county || r.counties.includes(county) || r.counties.includes('all')) &&
        (!age || (age >= r.age_min && age <= r.age_max))
    );
    $('count').textContent = `${shown.length} of ${resources.length} programs`;
    mount($('list'),
      ...shown.map((r) =>
        el('article', { class: 'card resource' },
          el('h3', {}, r.name, ' ', r.crisis ? el('span', { class: 'badge crisis' }, '24/7') : null),
          r.org && r.org !== r.name ? el('div', { class: 'org' }, r.org) : null,
          el('p', {}, r.description),
          contactLine(r),
          el('p', { class: 'small muted' },
            `Ages ${r.age_min}–${r.age_max} · `,
            r.counties.includes('all') ? 'Anywhere' : r.counties.map((c) => T.label.COUNTIES[c]?.split(' (')[0] || c).join(', ')),
          el('div', { class: 'chips' }, r.categories.map((c) => el('span', { class: 'badge' }, T.label.NEEDS[c] || c))),
          el('p', { class: 'small muted' }, r.last_verified ? `Verified ${fmtDate(r.last_verified)}` : 'Not yet verified by staff — call ahead.'))
      )
    );
  }

  for (const id of ['q', 'need', 'county', 'age']) $(id).addEventListener('input', render);
  render();
})();
