// Single source of truth for sidebar modules across both backend (permission catalog)
// and frontend (rendering). Keep keys stable — they are persisted in
// user_sidebar_permissions.module_key.
//
// `defaultRoles` lists the roles that should see this module by default
// (when the user has no explicit row in user_sidebar_permissions).

export const SIDEBAR_MODULES = [
  { key: 'dashboard',         label: 'Dashboard',          defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'leads',             label: 'Lead Management',    defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'contacts',          label: 'Contacts',           defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'inventory',         label: 'Inventory',          defaultRoles: ['ADMIN', 'OWNER', 'SUPERVISOR'] },
  { key: 'supervision',       label: 'Supervision Tasks',  defaultRoles: ['ADMIN', 'OWNER', 'SUPERVISOR'] },
  { key: 'lucky_draw',        label: 'Lucky Draw',         defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'users',             label: 'User Management',    defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'teams',             label: 'Teams',              defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'calls',             label: 'Call Management',    defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'attendance',        label: 'Attendance',         defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'chat',              label: 'Chat',               defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'bookings',          label: 'Bookings & Sales',   defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'tasks',             label: 'Task Management',    defaultRoles: ['ADMIN', 'OWNER', 'SUPERVISOR'] },
  { key: 'hr',                label: 'HR Management',      defaultRoles: ['ADMIN', 'OWNER'] },
  { key: 'settings',          label: 'Settings',           defaultRoles: ['ADMIN', 'OWNER'] },
];

export const SIDEBAR_MODULE_KEYS = SIDEBAR_MODULES.map((m) => m.key);

export const getDefaultModulesForRole = (role) => {
  if (role === 'OWNER' || role === 'ADMIN') {
    // Owner/Admin always see everything by default
    return SIDEBAR_MODULE_KEYS.slice();
  }
  return SIDEBAR_MODULES
    .filter((m) => m.defaultRoles.includes(role))
    .map((m) => m.key);
};

export const isValidModuleKey = (key) => SIDEBAR_MODULE_KEYS.includes(key);
