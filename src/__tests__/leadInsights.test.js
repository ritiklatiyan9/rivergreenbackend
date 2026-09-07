import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadInsightsScope } from '../utils/leadInsightsScope.js';
import { getLeadInsights, getClientInsights } from '../models/LeadInsights.model.js';

const site = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const user = { id: userId, site_id: site, role: 'ADMIN' };

test('lead insights use authenticated site and honor bounded filters', () => {
  const scope = parseLeadInsightsScope(user, { site_id: agentId, days: '90', agent_id: agentId, status: 'BOOKED', lead_category: 'HOT', search: '  Client  ' });
  assert.deepEqual(scope, { siteId: site, viewerId: null, agentId, days: 90, status: 'BOOKED', category: 'HOT', search: 'Client' });
});

test('agents and team heads cannot select another agent or broaden the lead scope', () => {
  for (const role of ['AGENT', 'TEAM_HEAD']) {
    const restricted = { ...user, role };
    assert.equal(parseLeadInsightsScope(restricted, {}).viewerId, userId);
    assert.equal(parseLeadInsightsScope(restricted, { agent_id: userId }).viewerId, userId);
    assert.throws(() => parseLeadInsightsScope(restricted, { agent_id: agentId }), error => error.statusCode === 403);
  }
});

test('invalid roles, dates, agent identifiers and filters fail before querying', () => {
  assert.throws(() => parseLeadInsightsScope({ ...user, role: 'STAFF' }), error => error.statusCode === 403);
  assert.throws(() => parseLeadInsightsScope({ ...user, site_id: null }), error => error.statusCode === 404);
  for (const query of [{ days: '365' }, { days: '30 OR 1=1' }, { agent_id: 'invalid' }, { status: 'FAKE' }, { lead_category: 'FAKE' }, { search: 'x'.repeat(101) }, { search: {} }]) {
    assert.throws(() => parseLeadInsightsScope(user, query), error => error.statusCode === 400);
  }
});

test('portfolio query parameterizes literal search and scopes all activity tables', async () => {
  const expected = { portfolio: { total: 1500 }, agents: [] };
  let query;
  const db = { query: async (sql, values) => { query = { sql, values }; return { rows: [expected] }; } };
  const result = await getLeadInsights(parseLeadInsightsScope(user, { agent_id: agentId, search: 'A_100%' }), db);
  assert.equal(result, expected);
  assert.deepEqual(query.values, [site, null, agentId, 30, null, null, '%A\\_100\\%%']);
  assert.match(query.sql, /l.site_id = \$1::uuid/);
  assert.match(query.sql, /c.site_id = \$1/);
  assert.match(query.sql, /f.site_id = \$1/);
  assert.match(query.sql, /GROUP BY c.lead_id/);
  assert.match(query.sql, /LIMIT 50/);
  assert.match(query.sql, /LIMIT 8/);
  assert.ok(!query.sql.includes('A_100%'));
});

test('client timeline is bounded separately from all-time aggregate counts', async () => {
  const db = { query: async (sql, values) => {
    assert.deepEqual(values, [agentId, site]);
    assert.match(sql, /c.lead_id = \$1::uuid AND c.site_id = \$2::uuid/);
    assert.match(sql, /f.lead_id = \$1 AND f.site_id = \$2/);
    assert.match(sql, /COUNT\(\*\)::int FROM events/);
    assert.match(sql, /LIMIT 100/);
    return { rows: [{ event_total: 200, timeline: [] }] };
  } };
  assert.equal((await getClientInsights(agentId, site, db)).event_total, 200);
});

// Exercise the real endpoint guard before the aggregate model can see data.
test('client endpoint rejects another site and an unowned lead before querying activity', async () => {
  const { clientInsights } = await import('../controllers/leadInsights.controller.js');
  const { default: leadModel } = await import('../models/Lead.model.js');
  const { default: pool } = await import('../config/db.js');
  const previousFind = leadModel.findById;
  const previousQuery = pool.query;
  let queries = 0;
  pool.query = async () => { queries += 1; return { rows: [{}] }; };
  const invoke = (request) => new Promise((resolve, reject) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    clientInsights(request, response, reject);
  });
  try {
    leadModel.findById = async () => ({ id: agentId, site_id: agentId, assigned_to: userId });
    assert.equal((await invoke({ user, params: { id: agentId } })).status, 404);
    leadModel.findById = async () => ({ id: agentId, site_id: site, owner_id: agentId, assigned_to: agentId });
    assert.equal((await invoke({ user: { ...user, role: 'AGENT' }, params: { id: agentId } })).status, 403);
    assert.equal((await invoke({ user, params: { id: 'invalid' } })).status, 400);
    assert.equal(queries, 0);
    leadModel.findById = async () => ({ id: agentId, site_id: site, owner_id: userId });
    assert.equal((await invoke({ user: { ...user, role: 'AGENT' }, params: { id: agentId } })).status, 200);
    assert.equal(queries, 1);
  } finally {
    leadModel.findById = previousFind;
    pool.query = previousQuery;
  }
});
