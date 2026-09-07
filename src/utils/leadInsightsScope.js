const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(['NEW', 'CONTACTED', 'INTERESTED', 'NOT_INTERESTED', 'SITE_VISIT', 'NEGOTIATION', 'BOOKED', 'LOST', 'INCOMING_OFF', 'SWITCH_OFF', 'NOT_ANSWERING']);
const categories = new Set(['PRIME', 'HOT', 'NORMAL', 'COLD', 'DEAD']);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export function parseLeadInsightsScope(user, query = {}) {
  if (!['ADMIN', 'OWNER', 'SUPERVISOR', 'AGENT', 'TEAM_HEAD'].includes(user?.role)) fail('Not authorized to view lead analytics', 403);
  if (!user.site_id || !UUID.test(user.site_id)) fail('No valid site assigned', 404);
  const days = query.days == null ? 30 : Number(query.days);
  if (![7, 30, 90].includes(days)) fail('Choose a 7, 30 or 90 day period');
  const agentId = query.agent_id && query.agent_id !== 'ALL' ? query.agent_id : null;
  if (agentId && (typeof agentId !== 'string' || !UUID.test(agentId))) fail('Invalid agent identifier');
  const restricted = ['AGENT', 'TEAM_HEAD'].includes(user.role);
  if (restricted && agentId && agentId !== user.id) fail('Not authorized to view another agent’s analytics', 403);
  const status = !query.status || query.status === 'ALL' ? null : query.status;
  const category = !query.lead_category || query.lead_category === 'ALL' ? null : query.lead_category;
  if (status && !statuses.has(status)) fail('Invalid lead status');
  if (category && !categories.has(category)) fail('Invalid lead category');
  if (query.search != null && (typeof query.search !== 'string' || query.search.length > 100)) fail('Search must be at most 100 characters');
  return { siteId: user.site_id, viewerId: restricted ? user.id : null, agentId,
    days, status, category, search: query.search?.trim() || null };
}
