import pool from '../config/db.js';
import leadModel from '../models/Lead.model.js';
import { getClientInsights, getLeadInsights } from '../models/LeadInsights.model.js';
import { parseLeadInsightsScope } from '../utils/leadInsightsScope.js';
import asyncHandler from '../utils/asyncHandler.js';

export const leadInsights = asyncHandler(async (req, res) => {
  const scope = parseLeadInsightsScope(req.user, req.query);
  // A selected agent is only meaningful within this site's recorded work.
  if (scope.agentId) {
    const agent = await pool.query(`SELECT u.id FROM users u WHERE u.id = $1 AND (
      u.site_id = $2 OR EXISTS (SELECT 1 FROM leads l WHERE l.site_id = $2 AND l.assigned_to = u.id)
    )`, [scope.agentId, scope.siteId]);
    if (!agent.rows.length) return res.status(404).json({ success: false, message: 'Agent not found in this site' });
  }
  const data = await getLeadInsights(scope, pool);
  res.json({ success: true, data, periodDays: scope.days, generatedAt: new Date().toISOString() });
});

export const clientInsights = asyncHandler(async (req, res) => {
  const scope = parseLeadInsightsScope(req.user, {});
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id || '')) {
    return res.status(400).json({ success: false, message: 'Invalid lead identifier' });
  }
  const lead = await leadModel.findById(req.params.id, pool);
  if (!lead || String(lead.site_id) !== String(scope.siteId)) return res.status(404).json({ success: false, message: 'Lead not found' });
  if (scope.viewerId && lead.owner_id !== scope.viewerId && lead.assigned_to !== scope.viewerId) {
    return res.status(403).json({ success: false, message: 'Not authorized to view this lead' });
  }
  const data = await getClientInsights(lead.id, scope.siteId, pool);
  res.json({ success: true, data, generatedAt: new Date().toISOString() });
});
