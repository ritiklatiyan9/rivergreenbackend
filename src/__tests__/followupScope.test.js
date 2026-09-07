import test from 'node:test';
import assert from 'node:assert/strict';

import { getScopeFilters } from '../controllers/followup.controller.js';

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherAgentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('admins may filter follow-ups by a specific agent', async () => {
  const scope = await getScopeFilters({ role: 'ADMIN', id: 'admin', site_id: siteId }, { assigned_to: agentId });
  assert.deepEqual(scope, { siteId, assignedTo: agentId });
});

test('"ALL" and a missing value leave the list unfiltered', async () => {
  for (const query of [{}, { assigned_to: 'ALL' }, { assigned_to: '' }]) {
    assert.deepEqual(await getScopeFilters({ role: 'ADMIN', id: 'admin', site_id: siteId }, query), { siteId });
  }
});

test('agents and team heads cannot widen scope to another agent', async () => {
  for (const role of ['AGENT', 'TEAM_HEAD']) {
    const scope = await getScopeFilters({ role, id: agentId, site_id: siteId }, { assigned_to: otherAgentId });
    assert.deepEqual(scope, { siteId, assignedTo: agentId }, `${role} must stay scoped to itself`);
  }
});

test('a malformed agent id matches nothing instead of reaching the query as-is', async () => {
  const scope = await getScopeFilters({ role: 'ADMIN', id: 'admin', site_id: siteId }, { assigned_to: "1' OR '1'='1" });
  assert.equal(scope.assignedTo, '00000000-0000-0000-0000-000000000000');
});

test('a user without a site gets no scope at all', async () => {
  assert.equal(await getScopeFilters({ role: 'ADMIN', id: 'admin' }, { assigned_to: agentId }), null);
});
