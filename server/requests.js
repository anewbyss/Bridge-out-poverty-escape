'use strict';

// "Refer me" requests: a young person asks staff to reach out and help them
// connect with a program. Saved in the database (so nothing is lost if email
// is down) and, on the server version, emailed to the staff inbox.

const T = require('./taxonomy');
const { ValidationError } = require('./validate');

const STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Reached out' },
  { id: 'connected', label: 'Connected to program' },
  { id: 'unreachable', label: 'Couldn’t reach' },
  { id: 'closed', label: 'Closed' },
];
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));
const NEED_IDS = T.ids(T.NEEDS);
const COUNTY_IDS = T.ids(T.COUNTIES);

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

function validateRequest(body, { resourceExists = () => true, staffAssisted = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (b.consent !== true) errors.push('Please check the box to agree to share this with our staff');
  const method = clean(b.contact_method, 10);
  if (!['text', 'call', 'email'].includes(method)) errors.push('Choose how staff should reach you');
  const value = clean(b.contact_value, 120);
  if (!value) errors.push('Add a phone number or email so staff can reach you');
  else if (method === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push('That email address doesn’t look right');
  else if (method !== 'email' && (value.replace(/\D/g, '').length < 7 || value.replace(/\D/g, '').length > 15)) errors.push('That phone number doesn’t look right');
  const age = b.age == null || b.age === '' ? null : Number(b.age);
  if (age != null && (!Number.isInteger(age) || age < 5 || age > 120)) errors.push('Age should be a whole number');
  // Children under 13: a trusted adult or staff must be helping (COPPA-style
  // protection — we don't take contact details from young children alone).
  const adult = b.adult_helper === true || staffAssisted;
  if (age != null && age < 13 && !adult) errors.push('If you’re under 13, please ask a trusted adult (or a staff member) to help you send this, and check the box that they are helping.');
  const resourceId = clean(b.resource_id, 80);
  if (resourceId && !resourceExists(resourceId)) errors.push('Unknown program');
  const need = clean(b.need, 40);
  if (need && !NEED_IDS.has(need)) errors.push('Unknown need');
  const county = clean(b.county, 20);
  if (county && !COUNTY_IDS.has(county)) errors.push('Unknown county');
  if (errors.length) throw new ValidationError(errors);
  return {
    ref_code: clean(b.ref_code, 12),
    resource_id: resourceId,
    program_name: clean(b.program_name, 200),
    need,
    first_name: clean(b.first_name, 40),
    age,
    county,
    contact_method: method,
    contact_value: value,
    safe_to_message: b.safe_to_message === true ? 1 : 0,
    best_time: clean(b.best_time, 100),
    note: clean(b.note, 1000),
    adult_helper: adult ? 1 : 0,
  };
}

// Fields encrypted at rest when a DATA_KEY is set (see server/vault.js).
const SEALED = ['first_name', 'contact_value', 'best_time', 'note', 'staff_note'];
const NO_VAULT = { seal: (v) => v, open: (v) => v };
const openRow = (row, vault) => {
  if (!row) return null;
  for (const k of SEALED) if (k in row) row[k] = vault.open(row[k]);
  return row;
};

function createRequest(db, r, vault = NO_VAULT) {
  const sealed = { ...r };
  for (const k of SEALED) if (k in sealed) sealed[k] = vault.seal(sealed[k]);
  const cols = Object.keys(sealed);
  const out = db.prepare(`INSERT INTO referral_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => sealed[c]));
  return getRequest(db, Number(out.lastInsertRowid), vault);
}

function getRequest(db, id, vault = NO_VAULT) {
  return openRow(db.prepare('SELECT * FROM referral_requests WHERE id = ?').get(id) || null, vault);
}

// `resourceIds` limits the list (program staff see only their programs).
function listRequests(db, { status = null, resourceIds = null, limit = 200, vault = NO_VAULT } = {}) {
  const where = [];
  const args = [];
  if (status && status !== 'all') {
    if (status === 'open') where.push("q.status IN ('new', 'contacted')");
    else where.push('q.status = ?'), args.push(status);
  }
  if (resourceIds) {
    if (!resourceIds.length) return [];
    where.push(`q.resource_id IN (${resourceIds.map(() => '?').join(', ')})`);
    args.push(...resourceIds);
  }
  return db
    .prepare(
      `SELECT q.*, COALESCE(r.name, q.program_name) AS program FROM referral_requests q
       LEFT JOIN resources r ON r.id = q.resource_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY q.created_at DESC, q.id DESC LIMIT ?`
    )
    .all(...args, Math.min(Number(limit) || 200, 1000))
    .map((row) => openRow(row, vault));
}

function countOpen(db, resourceIds = null) {
  return listRequests(db, { status: 'new', resourceIds, limit: 1000 }).length;
}

function updateRequest(db, id, body, user, vault = NO_VAULT) {
  const status = clean(body.status, 20);
  if (status && !STATUS_IDS.has(status)) throw new ValidationError(['Unknown status']);
  const cur = getRequest(db, id, vault);
  if (!cur) return null;
  const note = body.staff_note === undefined ? cur.staff_note : clean(body.staff_note, 2000);
  db.prepare(
    `UPDATE referral_requests SET status = ?, staff_note = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ?`
  ).run(status || cur.status, vault.seal(note), user ? user.name : null, id);
  return getRequest(db, id, vault);
}

function deleteRequest(db, id) {
  return db.prepare('DELETE FROM referral_requests WHERE id = ?').run(id).changes > 0;
}

function markEmailed(db, id, error = null) {
  db.prepare('UPDATE referral_requests SET emailed = ?, email_error = ? WHERE id = ?').run(error ? 0 : 1, error ? String(error).slice(0, 300) : null, id);
}

// What goes in the staff email. With details 'minimal' (the default) the
// email says a request arrived and which program, but the young person's
// contact information stays in the app behind staff sign-in. Gmail is not
// end-to-end encrypted and inboxes get forwarded, shared and breached.
function emailFor(req, { programName, details = 'minimal', staffUrl = null } = {}) {
  const prog = programName || req.program_name || 'General help (no specific program)';
  const lines = [
    `New “Refer me” request #${req.id}`,
    '',
    `Program: ${prog}`,
    req.need ? `Need: ${T.NEEDS.find((n) => n.id === req.need)?.label || req.need}` : null,
    req.county ? `Area: ${T.COUNTIES.find((c) => c.id === req.county)?.label || req.county}` : null,
    `Received: ${req.created_at} UTC`,
    '',
  ];
  if (details === 'full') {
    lines.push(
      'Contact details (confidential — do not forward):',
      `  Name: ${req.first_name || '(not given)'}`,
      `  Age: ${req.age ?? '(not given)'}`,
      `  Reach by: ${req.contact_method} — ${req.contact_value}`,
      `  OK to leave a message: ${req.safe_to_message ? 'Yes' : 'NO — do not leave messages'}`,
      `  Best time: ${req.best_time || '(any)'}`,
      req.adult_helper ? '  A trusted adult or staff member helped send this.' : null,
      req.note ? `  Note: ${req.note}` : null,
      ''
    );
  } else {
    lines.push('For privacy, contact details are not included in this email.', 'Sign in to the staff app to see them and mark the request handled.', '');
  }
  if (staffUrl) lines.push(`Open: ${staffUrl}`, '');
  lines.push('— Bridge Out of Poverty');
  return { subject: `Refer me #${req.id}: ${prog}`.slice(0, 150), text: lines.filter((l) => l != null).join('\n') };
}

module.exports = { STATUSES, validateRequest, createRequest, getRequest, listRequests, countOpen, updateRequest, deleteRequest, markEmailed, emailFor };
