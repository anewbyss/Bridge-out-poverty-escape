'use strict';

(async function () {
  const T = await loadTaxonomy();
  const form = document.getElementById('intake');
  const stepsEl = document.getElementById('steps');
  const errorsEl = document.getElementById('formErrors');
  const backBtn = document.getElementById('back');
  const nextBtn = document.getElementById('next');
  const staffMode = new URLSearchParams(location.search).get('staff') === '1';

  // ---------- Field builders ----------
  const choiceId = (name, id) => `f-${name}-${id}`;

  function chips(name, list, type = 'checkbox') {
    return el(
      'div',
      { class: 'chips', role: type === 'radio' ? 'radiogroup' : 'group' },
      list.map((o) =>
        el('label', { class: 'chip', for: choiceId(name, o.id) },
          el('input', { type, name, value: o.id, id: choiceId(name, o.id) }),
          o.label)
      )
    );
  }

  function groupedChips(name, list) {
    const groups = [...new Set(list.map((o) => o.group))];
    return groups.map((g) => [el('div', { class: 'group-title' }, g), chips(name, list.filter((o) => o.group === g))]);
  }

  function field(legend, hint, control) {
    return el('fieldset', {}, el('legend', {}, legend), hint && el('p', { class: 'hint' }, hint), control);
  }

  function select(name, list, placeholder = 'Choose one') {
    return el('select', { name, id: `f-${name}` },
      el('option', { value: '' }, placeholder),
      list.map((o) => el('option', { value: o.id }, o.label)));
  }

  // ---------- Steps ----------
  const steps = [
    {
      title: 'About you',
      render: () => [
        el('h2', {}, 'About you'),
        el('div', { class: 'row' },
          el('div', {},
            el('label', { class: 'label', for: 'f-age' }, 'How old are you?'),
            el('input', { type: 'number', name: 'age', id: 'f-age', min: T.AGE_MIN, max: T.AGE_MAX, inputmode: 'numeric', required: true })),
          el('div', {},
            el('label', { class: 'label', for: 'f-zip' }, 'ZIP code (optional)'),
            el('input', { type: 'text', name: 'zip', id: 'f-zip', inputmode: 'numeric', maxlength: 5, autocomplete: 'postal-code' }))),
        el('br'),
        field('Where are you staying or spending most of your time?', 'Not sure? Skip it — we’ll show programs from every area and say where each one works.',
          chips('county', [...T.COUNTIES, { id: '', label: 'Not sure' }], 'radio')),
        el('label', { class: 'label', for: 'f-language' }, 'What language do you prefer?'),
        select('language', T.LANGUAGES, 'English'),
      ],
      check: (v) => {
        const e = [];
        if (v.age != null && !Number.isInteger(v.age)) e.push('Age should be a whole number.');
        else if (v.age != null && (v.age < T.AGE_MIN || v.age > T.AGE_MAX))
          e.push(`This tool is for ages ${T.AGE_MIN}–${T.AGE_MAX}. Call or text 211 (text your ZIP to 898211) for help at any age.`);
        if (v.zip && !/^\d{5}$/.test(v.zip)) e.push('ZIP code should be 5 digits.');
        return e;
      },
    },
    {
      title: 'Who you’re housing',
      render: () => [
        el('h2', {}, 'Who are you looking for housing for?'),
        field('How many people will you be looking for housing for?', 'Shelters and housing programs need to know who’s coming with you.',
          chips('hh_for', T.HOUSEHOLD_FOR, 'radio')),
        el('div', { id: 'hh-more', class: 'hidden' },
          el('div', { class: 'row' },
            el('div', {},
              el('label', { class: 'label', for: 'f-hh_size' }, 'How many people in total, including you?'),
              el('input', { type: 'number', name: 'hh_size', id: 'f-hh_size', min: 2, max: 20, inputmode: 'numeric' }))),
          el('br'),
          field('Who is with you?', 'Pick all that apply.', chips('hh_members', T.HOUSEHOLD_MEMBERS)),
          el('div', { id: 'hh-kids', class: 'hidden' },
            field('How old are the children?', 'Pick all that apply. Some shelters and programs depend on children’s ages.', chips('hh_child_ages', T.CHILD_AGES))),
          field('Anything else we should know about your household?', 'Pick any that apply.', chips('hh_flags', T.HOUSEHOLD_FLAGS)),
          el('div', { id: 'hh-unsafe', class: 'notice hidden' },
            'You deserve to be safe. You can talk to someone confidentially, any time: Call to Safety ',
            el('a', { href: 'tel:5032355333' }, '503-235-5333'),
            ' or the National Domestic Violence Hotline — text START to 88788. We’ll show safety programs in your results.')),
      ],
      check: (v) => (v.household.size && (v.household.size < 2 || v.household.size > 20) ? ['Number of people should be between 2 and 20.'] : []),
    },
    {
      title: 'Who you are',
      render: () => [
        el('h2', {}, 'Who you are'),
        el('p', { class: 'hint' }, 'All optional. Some programs are run by and for specific communities — this helps us find ones that fit you, and helps us see who is (and isn’t) getting help.'),
        field('Race or ethnicity', 'Pick all that apply.', chips('race', T.RACE)),
        field('Sex assigned at birth', null, chips('sex', T.SEX, 'radio')),
        field('Gender identity', 'Pick all that apply.', chips('gender', T.GENDER)),
        field('Do you identify as LGBTQIA2S+?', null, chips('lgbtq', T.LGBTQ, 'radio')),
      ],
    },
    {
      title: 'Family & money',
      render: () => [
        el('h2', {}, 'Family & money'),
        field('Family situation', 'Pick all that apply.', chips('family', T.FAMILY)),
        field('Your income', 'Your own or your household’s, whichever you know.', chips('income', T.INCOME, 'radio')),
        field('Where does money come from?', 'Pick all that apply.', chips('income_sources', T.INCOME_SOURCES)),
      ],
    },
    {
      title: 'Housing, school & work',
      render: () => [
        el('h2', {}, 'Housing, school & work'),
        field('Where are you sleeping most nights?', null, chips('housing', T.HOUSING, 'radio')),
        field('School', null, chips('education', T.EDUCATION, 'radio')),
        field('Work', null, chips('employment', T.EMPLOYMENT, 'radio')),
      ],
    },
    {
      title: 'What’s going on',
      render: () => [
        el('h2', {}, 'What’s going on for you'),
        el('p', { class: 'hint' }, 'Optional, and only if you feel okay sharing. If anything here is happening, we’ll make sure you see 24/7 support first.'),
        field('Is any of this true for you right now?', 'Pick all that apply.', chips('vulnerabilities', T.VULNERABILITIES)),
      ],
    },
    {
      title: 'What you need',
      render: () => [
        el('h2', {}, 'What do you need help with?'),
        field('Pick everything that would help', 'If you skip this, we’ll show our main housing, rent, and utility help.', groupedChips('needs', T.NEEDS)),
        field('Which of these documents do you have right now?', 'We’ll make a step-by-step plan for any you’re missing — based on your age, area, and situation.',
          chips('documents', T.DOCUMENTS)),
        field('What matters to you in a program?', 'Optional — we’ll put programs like this first.', chips('preferences', T.PREFERENCES)),
        el('label', { class: 'label', for: 'f-notes' }, 'Anything else you want us to know? (optional)'),
        el('textarea', { name: 'notes', id: 'f-notes', maxlength: 2000 }),
      ],
    },
    {
      title: 'Privacy',
      render: () => [
        el('h2', {}, 'Your privacy'),
        el('div', { class: 'notice' },
          el('p', {}, 'We save your answers without your name so we can:'),
          el('ul', {},
            el('li', {}, 'show you programs that fit,'),
            el('li', {}, 'let you come back with your code and tell us how it went, and'),
            el('li', {}, 'show our community which needs aren’t being met and what gets in the way.')),
          el('p', { class: 'small' }, 'Staff at our program can see your answers. We never sell your information. Reports only show totals. You can ask staff to delete your record any time using your code.')),
        field('How much should we save?', null,
          el('div', { class: 'chips', role: 'radiogroup' },
            el('label', { class: 'chip', for: 'f-save-full' },
              el('input', { type: 'radio', name: 'save', value: 'full', id: 'f-save-full', checked: true }),
              'Save my answers — helps staff follow up and fix what isn’t working'),
            el('label', { class: 'chip', for: 'f-save-private' },
              el('input', { type: 'radio', name: 'save', value: 'private', id: 'f-save-private' }),
              'Private search — only keep my age, area, and needs')),
          el('p', { class: 'hint' }, 'Either way, we use all your answers to find matches, and you get a check-in code.')),
        el('label', { class: 'chip' }, el('input', { type: 'checkbox', name: 'consent', id: 'f-consent' }), 'I understand and want to continue *'),
        el('br'), el('br'),
        el('label', { class: 'chip', id: 'contactChip' }, el('input', { type: 'checkbox', name: 'contact_ok', id: 'f-contact_ok' }), 'It’s okay for a staff member to contact me to check in'),
        el('div', { id: 'contactFields', class: 'hidden' },
          el('br'),
          el('div', { class: 'row' },
            el('div', {},
              el('label', { class: 'label', for: 'f-contact_method' }, 'Best way to reach you'),
              select('contact_method', [{ id: 'text', label: 'Text' }, { id: 'call', label: 'Call' }, { id: 'email', label: 'Email' }])),
            el('div', {},
              el('label', { class: 'label', for: 'f-contact_value' }, 'Phone or email'),
              el('input', { type: 'text', name: 'contact_value', id: 'f-contact_value', autocomplete: 'off' }))),
          el('p', { class: 'hint' }, 'Only share a number or email that is safe for us to use.')),
      ],
      check: (v) => {
        const e = [];
        if (!v.consent) e.push('Please check the box to continue.');
        if (v.contact_ok && (!v.contact_method || !v.contact_value)) e.push('Tell us how to reach you, or uncheck the contact box.');
        return e;
      },
    },
  ];

  // All steps render once; we only toggle which one is visible so answers
  // survive moving back and forth.
  const stepEls = steps.map((s) => el('div', { class: 'step hidden' }, s.render()));
  stepsEl.append(...stepEls);
  const progress = document.getElementById('progress');

  const contactToggle = form.querySelector('#f-contact_ok');
  const syncContact = () => {
    const priv = form.querySelector('#f-save-private').checked;
    if (priv) contactToggle.checked = false;
    document.getElementById('contactChip').classList.toggle('hidden', priv);
    document.getElementById('contactFields').classList.toggle('hidden', !contactToggle.checked);
  };
  contactToggle.addEventListener('change', syncContact);
  for (const r of form.querySelectorAll('input[name=save]')) r.addEventListener('change', syncContact);

  // Quick search asks only the basics; full search asks everything. Every
  // question is optional either way, and "Skip to the end" is always there.
  const QUICK = [0, 1, 6, 7];
  let order = steps.map((_, i) => i);
  let pos = 0;
  let current = 0;
  const skipBtn = el('button', { class: 'btn secondary', type: 'button', onclick: () => show(order.length - 1) }, 'Skip to the end');
  nextBtn.before(skipBtn);

  function show(p) {
    pos = p;
    const i = (current = order[p]);
    stepEls.forEach((s, j) => s.classList.toggle('hidden', j !== i));
    mount(progress, order.map((_, j) => el('span', { class: j <= p ? 'done' : '' })));
    document.getElementById('stepCount').textContent = `Step ${p + 1} of ${order.length} · ${steps[i].title}`;
    backBtn.style.visibility = p === 0 ? 'hidden' : 'visible';
    skipBtn.classList.toggle('hidden', p >= order.length - 1);
    nextBtn.textContent = p === order.length - 1 ? 'Show my matches' : 'Next';
    mount(errorsEl);
    const first = stepEls[i].querySelector('h2');
    if (first) {
      first.tabIndex = -1;
      first.focus();
    }
    window.scrollTo({ top: 0 });
  }

  function values() {
    const fd = new FormData(form);
    const one = (k) => (fd.get(k) || '').toString().trim() || null;
    const many = (k) => fd.getAll(k).map(String);
    const num = (k) => (one(k) == null ? null : Number(one(k)));
    return {
      age: num('age'),
      zip: one('zip'),
      county: one('county'),
      language: one('language') || 'en',
      race: many('race'),
      sex: one('sex'),
      gender: many('gender'),
      lgbtq: one('lgbtq'),
      family: many('family'),
      household: household(fd),
      documents: many('documents'),
      income: one('income'),
      income_sources: many('income_sources'),
      housing: one('housing'),
      education: one('education'),
      employment: one('employment'),
      vulnerabilities: many('vulnerabilities'),
      needs: many('needs'),
      preferences: many('preferences'),
      notes: one('notes'),
      consent: fd.get('consent') === 'on',
      confidential: fd.get('save') === 'private',
      contact_ok: fd.get('contact_ok') === 'on',
      contact_method: one('contact_method'),
      contact_value: one('contact_value'),
    };
  }

  function household(fd) {
    const f = fd.get('hh_for');
    if (!f) return {};
    if (f === 'self') return { for: 'self', size: 1 };
    const size = Number(fd.get('hh_size')) || null;
    return {
      for: 'others',
      size,
      members: fd.getAll('hh_members'),
      child_ages: fd.getAll('hh_child_ages'),
      flags: fd.getAll('hh_flags'),
    };
  }

  // The household switch: follow-up questions appear only when someone is
  // looking for housing for more than themselves.
  const syncHousehold = () => {
    const others = form.querySelector('input[name=hh_for][value=others]').checked;
    document.getElementById('hh-more').classList.toggle('hidden', !others);
    document.getElementById('hh-kids').classList.toggle('hidden', !form.querySelector('input[name=hh_members][value=child]').checked);
    document.getElementById('hh-unsafe').classList.toggle('hidden', !form.querySelector('input[name=hh_flags][value=unsafe_member]').checked);
  };
  form.addEventListener('change', (e) => {
    if (/^hh_/.test(e.target.name)) syncHousehold();
    // "None of these" and specific documents are mutually exclusive.
    if (e.target.name === 'documents' && e.target.checked) {
      for (const d of form.querySelectorAll('input[name=documents]'))
        if ((e.target.value === 'none') !== (d.value === 'none')) d.checked = false;
    }
  });

  function showErrors(list) {
    mount(errorsEl, el('div', { class: 'errors', role: 'alert' }, el('ul', {}, list.map((e) => el('li', {}, e)))));
    errorsEl.scrollIntoView({ block: 'center' });
  }

  backBtn.addEventListener('click', () => pos > 0 && show(pos - 1));
  nextBtn.addEventListener('click', async () => {
    const v = values();
    const errs = steps[current].check ? steps[current].check(v) : [];
    if (errs.length) return showErrors(errs);
    if (pos < order.length - 1) return show(pos + 1);

    nextBtn.disabled = true;
    nextBtn.textContent = 'Finding matches…';
    try {
      const result = await api('/api/intake', {
        method: 'POST',
        body: v,
        headers: staffMode ? { 'X-Intake-Source': 'staff' } : {},
      });
      form.classList.add('hidden');
      renderResults(document.getElementById('results'), result, T);
      window.scrollTo({ top: 0 });
    } catch (err) {
      mount(errorsEl, errorBox(err));
    } finally {
      nextBtn.disabled = false;
      nextBtn.textContent = 'Show my matches';
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  function begin(quick) {
    order = quick ? QUICK : steps.map((_, i) => i);
    document.getElementById('intro').classList.add('hidden');
    form.classList.remove('hidden');
    show(0);
  }
  document.getElementById('start').addEventListener('click', () => begin(false));
  document.getElementById('quick').addEventListener('click', () => begin(true));

})();
