'use strict';

(async function () {
  const [T, catalog] = await Promise.all([loadTaxonomy(), api('/api/benefits')]);
  const $ = (id) => document.getElementById(id);
  const form = $('screener');
  const out = $('results');

  mount($('q-county'),
    el('option', { value: '' }, 'Not sure / skip'),
    T.COUNTIES.map((c) => el('option', { value: c.id }, c.label)));
  mount($('flags'),
    catalog.flags.map((f) => el('label', { class: 'chip' }, el('input', { type: 'checkbox', name: 'flags', value: f.id }), f.label)));

  function whereBlock(w) {
    return el('div', { class: 'where' },
      el('strong', {}, w.name),
      w.address ? el('div', { class: 'small' }, `📍 ${w.address}`) : null,
      w.hours ? el('div', { class: 'small' }, `🕒 ${w.hours}`) : null,
      el('div', { class: 'contact' },
        w.phone ? el('a', { href: telHref(w.phone) || undefined }, `📞 ${w.phone}`) : null,
        w.url ? el('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer' }, '🌐 Website') : null),
      w.note ? el('div', { class: 'small muted' }, w.note) : null);
  }

  function programCard(p) {
    return el('article', { class: `card resource program ${p.level}` },
      el('div', { class: 'chips' },
        el('span', { class: p.level === 'likely' ? 'badge likely' : 'badge warn' }, p.level === 'likely' ? 'Likely' : 'Maybe'),
        p.nafy ? el('span', { class: 'badge' }, 'New Avenues for Youth') : null),
      el('h3', {}, p.name),
      el('p', {}, p.summary),
      p.why.length ? el('ul', { class: 'reasons' }, p.why.map((w) => el('li', {}, w))) : null,
      p.rules ? el('p', { class: 'small muted' }, `Rules: ${p.rules}`) : null,
      el('details', { open: p.level === 'likely' },
        el('summary', {}, 'Where & how to apply'),
        el('h4', {}, 'How'),
        el('ol', {}, p.how.map((h) => el('li', {}, h))),
        el('h4', {}, 'Where'),
        p.where.map(whereBlock),
        p.bring?.length ? [el('h4', {}, 'What to bring'), el('ul', {}, p.bring.map((b) => el('li', {}, b)))] : null),
      el('div', { class: 'actions' }, el('span'),
        referButton({ resource_id: p.resource_id || null, program_name: p.name, resource_name: p.name, need: p.need || null }, 'Refer me — have staff help')));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const age = fd.get('age') ? Number(fd.get('age')) : null;
    if (age != null && (!Number.isInteger(age) || age < 5 || age > 99))
      return mount($('formErrors'), el('div', { class: 'errors' }, 'Age should be a whole number.'));
    mount($('formErrors'));
    const body = {
      age,
      household_size: fd.get('household_size') ? Number(fd.get('household_size')) : 1,
      monthly_income: String(fd.get('monthly_income') || '').trim() || null,
      county: fd.get('county') || null,
      flags: fd.getAll('flags'),
    };
    $('go').disabled = true;
    try {
      const r = await api('/api/screener', { method: 'POST', body });
      render(r);
    } catch (err) {
      mount($('formErrors'), errorBox(err));
    } finally {
      $('go').disabled = false;
    }
  });

  function render(r) {
    mount(out,
      el('section', { class: 'card' },
        el('h1', {}, r.total ? `${r.likely} likely · ${r.total - r.likely} maybe` : 'No clear matches yet'),
        r.percentOfPoverty != null
          ? el('p', { class: 'small muted' }, `Your household income is about ${r.percentOfPoverty}% of the ${r.fplYear} federal poverty level for ${r.householdSize} ${r.householdSize === 1 ? 'person' : 'people'}. Many programs use this number.`)
          : el('p', { class: 'small muted' }, 'You didn’t enter income, so income-based programs show as “maybe”.'),
        el('p', { class: 'notice small' }, '“Likely” means your answers fit the program’s main rules. It is not a promise. Only the program can decide, and openings change. Call ahead, and apply to more than one.'),
        el('div', { class: 'actions no-print' },
          el('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'Print / save as PDF'),
          el('button', { class: 'btn secondary', type: 'button', onclick: () => (out.classList.add('hidden'), form.scrollIntoView()) }, 'Change answers'),
          referButton({ program_name: 'Help figuring out which programs fit me' }, 'Not sure? Ask staff to help'))),
      r.groups.map((g) =>
        el('section', { class: 'need-group' },
          el('h2', {}, g.label),
          g.programs.map(programCard))),
      !r.total
        ? el('div', { class: 'card' }, el('p', {}, 'Try checking more boxes above, or call 211 (text your ZIP to 898211). You can also ', el('a', { href: '/' }, 'search programs by need'), '.'))
        : null);
    out.classList.remove('hidden');
    out.scrollIntoView();
  }
})();
