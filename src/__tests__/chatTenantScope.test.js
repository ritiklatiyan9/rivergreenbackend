import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ChatScopeError,
  ensureChatParticipantsInSite,
  listChatUsersForSite,
} from '../services/chat.service.js';
import ChatConversation from '../models/ChatConversation.model.js';

const siteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherUserId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

test('chat user discovery is restricted to the effective authenticated site', async () => {
  let inspected = false;
  const users = await listChatUsersForSite({
    currentUserId: userId,
    siteId,
    db: {
      query: async (sql, params) => {
        inspected = true;
        assert.match(sql, /u\.site_id = \$2/);
        assert.match(sql, /user_site_access/);
        assert.match(sql, /supervisor_site_access/);
        assert.deepEqual(params, [userId, siteId]);
        return { rows: [{ id: otherUserId, name: 'Allowed User' }] };
      },
    },
  });

  assert.equal(inspected, true);
  assert.deepEqual(users, [{ id: otherUserId, name: 'Allowed User' }]);
});

test('direct/group participants must all belong to the effective site', async () => {
  const allowed = await ensureChatParticipantsInSite({
    siteId,
    participantIds: [otherUserId, otherUserId],
    db: {
      query: async (sql, params) => {
        assert.match(sql, /u\.id = ANY\(\$2::uuid\[\]\)/);
        assert.deepEqual(params, [siteId, [otherUserId]]);
        return { rows: [{ id: otherUserId }] };
      },
    },
  });
  assert.deepEqual(allowed, [otherUserId]);

  await assert.rejects(
    () => ensureChatParticipantsInSite({
      siteId,
      participantIds: [otherUserId],
      db: { query: async () => ({ rows: [] }) },
    }),
    (error) => error instanceof ChatScopeError && error.statusCode === 403,
  );
});

test('invalid participant IDs are rejected before querying PostgreSQL', async () => {
  let queried = false;
  await assert.rejects(
    () => ensureChatParticipantsInSite({
      siteId,
      participantIds: ['not-a-uuid'],
      db: { query: async () => { queried = true; } },
    }),
    (error) => error instanceof ChatScopeError && error.statusCode === 400,
  );
  assert.equal(queried, false);
});

test('legacy cross-site conversations fail the site-safe participation check', async () => {
  let captured;
  const allowed = await ChatConversation.isParticipantForSite(
    'conversation-1',
    userId,
    siteId,
    {
      query: async (sql, params) => {
        captured = { sql, params };
        return { rows: [] };
      },
    },
  );

  assert.equal(allowed, false);
  assert.match(captured.sql, /NOT EXISTS/);
  assert.match(captured.sql, /u\.site_id = \$3/);
  assert.deepEqual(captured.params, ['conversation-1', userId, siteId]);
});
