import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { cacheMiddleware, normalizeCachePattern } from '../middlewares/cache.middleware.js';
import { rateLimit, _clearRateLimitBucketsForTests } from '../middlewares/rateLimit.middleware.js';
import { resolveEffectiveSiteId } from '../middlewares/auth.middleware.js';
import { actorCanManageEverySite, actorCanManageSite } from '../controllers/admin.controller.js';
import callModel from '../models/Call.model.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.body = undefined;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), value);
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(body) {
    this.body = body;
    this.emit('finish');
    return this;
  }
}

const makeRequest = ({ siteId = 'site-a', rawSiteId = undefined, url = '/api/test' } = {}) => ({
  method: 'GET',
  originalUrl: url,
  user: { id: 'user-a', site_id: siteId },
  header: (name) => (name.toLowerCase() === 'x-site-id' ? rawSiteId : undefined),
});

test('legacy cache bust patterns expand to the user + site key format', () => {
  assert.equal(
    normalizeCachePattern('cache:*:/api/leads*'),
    'cache:*:*:/api/leads*',
  );
  assert.equal(
    normalizeCachePattern('cache:*:site-a:/api/leads*'),
    'cache:*:site-a:/api/leads*',
  );
});

test('cache key trusts the auth-resolved site, not a forged raw header', async () => {
  const middleware = cacheMiddleware(30);
  const url = `/api/cache-site-test-${Date.now()}`;
  const firstResponse = new FakeResponse();

  await middleware(
    makeRequest({ siteId: 'real-site', rawSiteId: 'forged-site', url }),
    firstResponse,
    () => firstResponse.json({ success: true, value: 42 }),
  );

  const secondResponse = new FakeResponse();
  let nextCalled = false;
  await middleware(
    makeRequest({ siteId: 'real-site', url }),
    secondResponse,
    () => { nextCalled = true; },
  );

  assert.equal(nextCalled, false);
  assert.deepEqual(secondResponse.body, { success: true, value: 42 });
  assert.equal(secondResponse.getHeader('x-cache'), 'L1');
});

test('identical cache misses are coalesced into one downstream request', async () => {
  const middleware = cacheMiddleware(30);
  const url = `/api/cache-flight-test-${Date.now()}`;
  const firstResponse = new FakeResponse();
  const secondResponse = new FakeResponse();
  let downstreamCalls = 0;

  await middleware(makeRequest({ url }), firstResponse, () => { downstreamCalls += 1; });
  const secondRequest = middleware(
    makeRequest({ url }),
    secondResponse,
    () => { downstreamCalls += 1; },
  );

  firstResponse.json({ success: true, value: 'shared' });
  await secondRequest;

  assert.equal(downstreamCalls, 1);
  assert.deepEqual(secondResponse.body, { success: true, value: 'shared' });
  assert.equal(secondResponse.getHeader('x-cache'), 'COALESCED');
});

test('production CORS is explicit while Capacitor origin remains allowed', { concurrency: false }, async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
  };

  process.env.NODE_ENV = 'production';
  process.env.CORS_ORIGINS = 'https://sales.example.com,*';
  const cors = await import(`../config/cors.js?hardening-test=${Date.now()}`);

  assert.equal(cors.isOriginAllowed('https://sales.example.com'), true);
  assert.equal(cors.isOriginAllowed('capacitor://localhost'), true);
  assert.equal(cors.isOriginAllowed('https://attacker.example'), false);
  assert.equal(cors.isOriginAllowed(undefined), true);

  if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous.NODE_ENV;
  if (previous.CORS_ORIGINS === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = previous.CORS_ORIGINS;
});

test('auth rate limiter returns a bounded 429 response', () => {
  _clearRateLimitBucketsForTests();
  const limiter = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'test' });
  const request = { ip: '127.0.0.1', id: 'request-id' };
  let accepted = 0;

  limiter(request, new FakeResponse(), () => { accepted += 1; });
  limiter(request, new FakeResponse(), () => { accepted += 1; });
  const rejected = new FakeResponse();
  limiter(request, rejected, () => { accepted += 1; });

  assert.equal(accepted, 2);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.body.success, false);
  assert.ok(Number(rejected.getHeader('retry-after')) >= 1);
});

test('device call-log sync uses one bounded set-based database query', async () => {
  const queries = [];
  const fakePool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 1, rows: [{ id: 'call-1' }] };
    },
  };

  const result = await callModel.syncDeviceCallLog([
    {
      phone_number: '+91 98765-43210',
      call_start: '2026-08-01T10:00:00.000Z',
      call_type: 'OUTGOING',
      duration_seconds: 25,
    },
    { phone_number: '', call_start: 'invalid' },
  ], { siteId: 'site-a', userId: 'user-a' }, fakePool);

  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /WITH incoming AS/);
  assert.deepEqual(queries[0].params[2], ['+919876543210']);
  assert.deepEqual(result, { synced: 1, skipped: 1 });
});

test('site switching is tenant-scoped for admins and owners', () => {
  const base = {
    primarySiteId: 'site-a',
    assignedSiteIds: ['site-a', 'site-b'],
    requestedSiteActive: true,
  };

  assert.equal(resolveEffectiveSiteId({
    ...base,
    role: 'ADMIN',
    requestedSiteId: 'site-b',
  }), 'site-b');
  assert.equal(resolveEffectiveSiteId({
    ...base,
    role: 'ADMIN',
    requestedSiteId: 'site-c',
  }), 'site-a');
  assert.equal(resolveEffectiveSiteId({
    ...base,
    role: 'OWNER',
    requestedSiteId: 'site-c',
    ownerHasRequestedSite: false,
  }), 'site-a');
  assert.equal(resolveEffectiveSiteId({
    ...base,
    role: 'OWNER',
    requestedSiteId: 'site-c',
    ownerHasRequestedSite: true,
  }), 'site-c');
});

test('admin-panel site mutations cannot cross tenant boundaries', () => {
  const owner = { id: 'owner-a', role: 'OWNER' };
  const admin = { id: 'admin-a', role: 'ADMIN', site_id: 'site-a' };

  assert.equal(actorCanManageSite(owner, { id: 'site-a', created_by: 'owner-a' }), true);
  assert.equal(actorCanManageSite(owner, { id: 'site-b', created_by: 'owner-b' }), false);
  assert.equal(actorCanManageSite(owner, { id: 'legacy-site', created_by: null }), false);
  assert.equal(actorCanManageSite(admin, { id: 'site-a', created_by: 'owner-a' }), true);
  assert.equal(actorCanManageSite(admin, { id: 'site-b', created_by: 'owner-a' }), false);
});

test('bulk site replacement cannot erase another tenant grant', () => {
  const owner = { id: 'owner-a', role: 'OWNER' };
  const admin = { id: 'admin-a', role: 'ADMIN', site_id: 'site-a' };

  assert.equal(actorCanManageEverySite(owner, [
    { id: 'site-a', created_by: 'owner-a' },
    { id: 'site-b', created_by: 'owner-a' },
  ]), true);
  assert.equal(actorCanManageEverySite(owner, [
    { id: 'site-a', created_by: 'owner-a' },
    { id: 'site-x', created_by: 'owner-b' },
  ]), false);
  assert.equal(actorCanManageEverySite(admin, [
    { id: 'site-a', created_by: 'owner-a' },
  ]), true);
  assert.equal(actorCanManageEverySite(admin, [
    { id: 'site-a', created_by: 'owner-a' },
    { id: 'site-b', created_by: 'owner-a' },
  ]), false);
});
