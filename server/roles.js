'use strict';

// Staff roles and what each one may do. Every staff route names the
// permission it needs (see app.js); this table is the single source of truth.
//
//   architect        Main architect / owner. Everything, including managing
//                    other architects and maintainers.
//   maintainer       Maintenance personnel. Everything except managing
//                    architect accounts.
//   case_worker      Front-line staff. Youth records, follow-ups, referral
//                    requests, the full directory and discovery. No account
//                    or system settings.
//   program_partner  Staff at a partner program (e.g. one New Avenues
//                    program). Can edit and verify ONLY the programs assigned
//                    to them and see Refer-me requests for those programs. No
//                    youth intake records, dashboard or exports.

const ROLES = [
  { id: 'architect', label: 'Main architect', rank: 4, description: 'Full control, including other architects and system settings.' },
  { id: 'maintainer', label: 'Maintenance', rank: 3, description: 'Manage staff accounts, settings, data retention and the whole directory.' },
  { id: 'case_worker', label: 'Case worker', rank: 2, description: 'Youth records, follow-ups, referral requests, directory and discovery.' },
  { id: 'program_partner', label: 'Program staff', rank: 1, description: 'Edit only their own program listings and see referral requests sent to them.' },
];

const PERMISSIONS = {
  // Youth data
  'youth.view': ['architect', 'maintainer', 'case_worker'],
  'youth.edit': ['architect', 'maintainer', 'case_worker'],
  'youth.delete': ['architect', 'maintainer', 'case_worker'],
  'dashboard.view': ['architect', 'maintainer', 'case_worker'],
  'export': ['architect', 'maintainer', 'case_worker'],
  // Refer-me requests (partners only see ones for their programs)
  'requests.view': ['architect', 'maintainer', 'case_worker', 'program_partner'],
  'requests.all': ['architect', 'maintainer', 'case_worker'],
  // Directory
  'resources.view': ['architect', 'maintainer', 'case_worker', 'program_partner'],
  'resources.edit_own': ['architect', 'maintainer', 'case_worker', 'program_partner'],
  'resources.edit_all': ['architect', 'maintainer', 'case_worker'],
  'resources.bulk': ['architect', 'maintainer'],
  'discovery': ['architect', 'maintainer', 'case_worker'],
  // System
  'users.manage': ['architect', 'maintainer'],
  'settings.edit': ['architect', 'maintainer'],
  'audit.view': ['architect', 'maintainer'],
};

const ROLE_IDS = new Set(ROLES.map((r) => r.id));
const rank = (role) => ROLES.find((r) => r.id === role)?.rank || 0;

function can(user, perm) {
  if (!user) return false;
  const allowed = PERMISSIONS[perm];
  if (!allowed) throw new Error(`Unknown permission: ${perm}`);
  return allowed.includes(user.role);
}

// Program partners may only touch programs listed on their account.
function canEditResource(user, resourceId) {
  if (can(user, 'resources.edit_all')) return true;
  return can(user, 'resources.edit_own') && (user.programs || []).includes(resourceId);
}

// Who may create/edit/disable an account with `targetRole`. Maintainers can
// manage everyone below architect; only architects manage architects.
function canManageRole(user, targetRole) {
  if (!can(user, 'users.manage')) return false;
  if (user.role === 'architect') return true;
  return rank(targetRole) < rank('architect');
}

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(role));
}

module.exports = { ROLES, ROLE_IDS, PERMISSIONS, can, canEditResource, canManageRole, permissionsFor };
