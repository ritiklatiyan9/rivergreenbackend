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

// Navigation buttons are picked here, not by the model. Small free models call
// tools reliably but fail a strict JSON contract, which used to sink the whole
// answer — deriving the destination from the question keeps buttons working no
// matter which model served the request. First match wins, so the list runs
// specific → generic. Patterns cover the Hinglish agents actually type.
const ACTION_RULES = [
  { match: /\b(import|excel|xlsx|sheet|csv|bulk\s*upload)\b/i, label: 'Import Leads', route: '/leads/bulk' },
  { match: /\b(add|naya|nayi|new)\b.{0,12}\blead\b|\blead\b.{0,12}\b(add|banao|jodo)\b/i, label: 'Add Lead', route: '/leads/add' },
  { match: /\b(assign|batwara|transfer)\b.{0,12}\blead\b|\blead\b.{0,12}\bassign\b/i, label: 'Assign Leads', route: '/leads/assign' },
  { match: /\b(overdue|missed|chhut|chhoot)\b.{0,16}\b(follow|call)/i, label: 'Missed Follow-ups', route: '/calls/missed-followups' },
  { match: /\b(follow[\s-]?up|schedule|reminder|appointment|due)\b/i, label: 'Scheduled Calls', route: '/calls/scheduled' },
  { match: /\b(analytic|report|performance|kitni\s*call|connect\s*rate)\b/i, label: 'Call Analytics', route: '/calls/analytics' },
  { match: /\b(dial|dialer|calling\s*start|call\s*(karni|karna|karu|karun))\b/i, label: 'Open Dialer', route: '/calls/dialer' },
  { match: /\b(attendance|hazri|haziri|check[\s-]?in|check[\s-]?out)\b/i, label: 'Mark Attendance', route: '/attendance' },
  { match: /\b(booking|booked|plot\s*book)\b/i, label: 'Bookings', route: '/bookings' },
  { match: /\b(payment|installment|collection|paisa|bhugtan)\b/i, label: 'Sales & Payments', route: '/sales' },
  { match: /\b(task|kaam)\b/i, label: 'Tasks', route: '/supervision-tasks' },
  { match: /\b(map|plot|colony)\b/i, label: 'Colony Maps', route: '/colony-maps' },
  { match: /\b(contact|phonebook)\b/i, label: 'Contacts', route: '/all-contacts' },
  { match: /\b(chat|message)\b/i, label: 'Team Chat', route: '/chat' },
  { match: /\b(fresh|nayi\s*lead|naye\s*lead|uncalled)\b/i, label: 'Fresh Leads', route: '/leads?status=NEW&from=fresh' },
  { match: /\blead|customer|pipeline\b/i, label: 'View Leads', route: '/leads' },
];

export const suggestActions = (message) => {
  const text = String(message ?? '');
  const rule = ACTION_RULES.find((candidate) => candidate.match.test(text));
  // Route check still applies even though the table is ours: it catches a typo
  // here before the app tries to navigate somewhere that does not exist.
  return rule && isAllowedRoute(rule.route) ? [{ label: rule.label, route: rule.route }] : [];
};

const HOWTO_PATTERN = /\b(kaise|kese|kaisay|kaeise|kahan|kaha|kidhar|how|where|steps?|tarika|tarike|process)\b/i;

// "How do I import an Excel sheet" needs the app map, not a language model.
// Answering it here keeps the assistant useful when the AI provider is rate
// limited or down, instead of falling through to an unrelated data summary.
export const answerHowTo = (message) => {
  const text = String(message ?? '');
  if (!HOWTO_PATTERN.test(text)) return null;
  const [action] = suggestActions(text);
  if (!action) return null;
  const base = action.route.split('?')[0];
  const feature = APP_FEATURES.find((candidate) => candidate.route.split('?')[0] === base);
  return feature ? { how: feature.how, title: feature.title } : null;
};
