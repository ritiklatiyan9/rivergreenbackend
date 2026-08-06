// App feature map for the AI assistant: every navigable feature of the agent
// app (rgsalesagent), the route that opens it, and how to use it. Injected into
// the assistant's system prompt (small + static → provider prompt caching) and
// used to validate navigation actions the model emits.
//
// ponytail: plain list in a prompt, no vector store — ~35 features fit in ~1.5k
// tokens; revisit only if the catalog grows 10x.

export const APP_FEATURES = [
  { route: '/', title: 'Home Dashboard', how: 'Daily summary: stats, quick shortcuts, today\'s work overview.' },
  { route: '/leads', title: 'Leads List', how: 'All your leads. Search by name/phone, filter by status and category chips at the top.' },
  { route: '/leads/add', title: 'Add Single Lead', how: 'Leads → "+" / Add. Fill name, phone, status, source, notes and save.' },
  { route: '/leads/bulk', title: 'Import Leads from Excel', how: 'Leads → Import tab. First tap "Download Template" (columns: name*, phone*, email, address, profession, status, notes), fill it, then upload the Excel file, review the parsed rows/errors and confirm Import.' },
  { route: '/leads/assign', title: 'Assign Leads', how: 'Leads → Assign tab. Select leads and assign them to a team member.' },
  { route: '/leads/assignment-history', title: 'Lead Assignment History', how: 'Leads → History tab. Who was assigned which leads and when.' },
  { route: '/leads?status=NEW&from=fresh', title: 'Fresh Leads', how: 'Bottom nav "Fresh". New leads that have never been called.' },
  { route: '/matter-leads', title: 'Matter Leads', how: 'High-priority leads that need action, with direct Call and WhatsApp buttons.' },
  { route: '/calls', title: 'Call Dashboard', how: 'Call stats and overview for the day/week.' },
  { route: '/calls/dialer', title: 'Dialer', how: 'Bottom nav "Calls". Dial any number; the call gets detected and you log outcome + next step after it ends.' },
  { route: '/calls/leads-dialer', title: 'Leads Dialer (Auto Queue)', how: 'Call your lead queue one by one without manual dialing; log each outcome between calls.' },
  { route: '/calls/log', title: 'Log a Call Manually', how: 'Record a call that happened outside the app: pick lead, outcome, notes, next action.' },
  { route: '/calls/daily', title: 'Daily Call Entry', how: 'Bulk-enter the day\'s call results in one screen.' },
  { route: '/calls/scheduled', title: 'Scheduled Calls / Follow-ups', how: 'Bottom nav "Schedule". Today\'s and upcoming follow-ups; call directly from each row.' },
  { route: '/calls/missed-followups', title: 'Missed Follow-ups', how: 'Follow-ups whose scheduled time passed without a call. Clear them by calling or rescheduling.' },
  { route: '/calls/missed', title: 'Missed Calls', how: 'Incoming calls you missed on your phone, matched to leads.' },
  { route: '/calls/analytics', title: 'Call Analytics', how: 'Charts: calls per day, connect rate, talk time, outcomes.' },
  { route: '/calls/history', title: 'Call History', how: 'Full list of past calls with duration and outcome.' },
  { route: '/calls/lead/:leadId', title: 'Lead Call Timeline', how: 'Complete call history of one lead.' },
  { route: '/all-contacts', title: 'Contacts', how: 'Phone-book contacts synced into the app.' },
  { route: '/contacts/shift-to-call', title: 'Shift Contacts to Call Queue', how: 'Select contacts and push them into your calling queue as leads.' },
  { route: '/colony-maps', title: 'Colony Maps', how: 'Visual plot maps of the site; tap a plot for its details and status.' },
  { route: '/colony-maps/plots', title: 'Manage Plots', how: 'Plot inventory: numbers, sizes, prices, availability.' },
  { route: '/bookings', title: 'Plot Bookings', how: 'All bookings; open one for payment schedule, receipts and status.' },
  { route: '/sales', title: 'Sales Dashboard', how: 'Sales figures, conversions and collections overview.' },
  { route: '/tasks', title: 'Tasks', how: 'Your task list; mark tasks complete as you finish.' },
  { route: '/supervision-tasks', title: 'Supervision Tasks', how: 'Tasks assigned by your supervisor with due dates and priorities.' },
  { route: '/reminders', title: 'Reminders', how: 'Personal reminders with date/time alerts.' },
  { route: '/team', title: 'Team Members', how: 'Your team list and their performance.' },
  { route: '/team/manage', title: 'Manage Team', how: 'Add/register agents and manage team structure (team head/admin).' },
  { route: '/team/performance', title: 'Team Performance', how: 'Compare members: calls, conversions, bookings.' },
  { route: '/content-share', title: 'Content Share', how: 'Marketing material (images, brochures) ready to share with customers on WhatsApp.' },
  { route: '/attendance', title: 'Mark Attendance', how: 'Check in when you start and check out when you finish; location is verified.' },
  { route: '/attendance/history', title: 'My Attendance', how: 'Your month\'s attendance record: present, late, half days.' },
  { route: '/chat', title: 'Team Chat', how: 'Internal chat with teammates and groups.' },
  { route: '/profile', title: 'Profile', how: 'Your account details, password and app settings.' },
];

const STATIC_ROUTES = new Set(APP_FEATURES.map((f) => f.route.split('?')[0]).filter((r) => !r.includes(':')));

// Parametrized detail pages the model may deep-link with a real id.
const PARAM_ROUTE_PATTERNS = [
  /^\/calls\/lead\/[\w-]+$/,
  /^\/bookings\/[\w-]+$/,
  /^\/colony-maps\/[\w-]+$/,
  /^\/team\/member\/[\w-]+$/,
];

export const isAllowedRoute = (route) => {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('://')) return false;
  const base = route.split(/[?#]/)[0];
  return STATIC_ROUTES.has(base) || PARAM_ROUTE_PATTERNS.some((pattern) => pattern.test(base));
};

export const buildAppMapPrompt = () => APP_FEATURES
  .map((f) => `${f.route} | ${f.title} | ${f.how}`)
  .join('\n');
