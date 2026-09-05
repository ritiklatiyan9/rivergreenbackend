import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifyLocalReceiptToken,
  verifyReceiptAcrossSystems,
} from '../utils/receiptVerification.js';

const signedToken = (payload, secret) => {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: signature })).toString('base64url');
};

test('Bookings receipt is verified locally without contacting Accounts', async () => {
  const previousSecret = process.env.RECEIPT_VERIFY_SECRET;
  process.env.RECEIPT_VERIFY_SECRET = 'bookings-secret';
  try {
    const payload = { t: 'PLT', i: 'booking_payment_19', a: 25000 };
    const token = signedToken(payload, 'bookings-secret');
    let fetchCalled = false;
    const result = await verifyReceiptAcrossSystems(token, async () => {
      fetchCalled = true;
      throw new Error('should not be called');
    });

    assert.deepEqual(result, { valid: true, receipt: payload });
    assert.equal(fetchCalled, false);
  } finally {
    if (previousSecret === undefined) delete process.env.RECEIPT_VERIFY_SECRET;
    else process.env.RECEIPT_VERIFY_SECRET = previousSecret;
  }
});

test('Accounts receipt is delegated to the Accounts verifier', async () => {
  const previousSecret = process.env.RECEIPT_VERIFY_SECRET;
  const previousAccountsUrl = process.env.ACCOUNTS_API_URL;
  process.env.RECEIPT_VERIFY_SECRET = 'bookings-secret';
  process.env.ACCOUNTS_API_URL = 'https://accounts.example.test/';
  try {
    const payload = { t: 'NOC', i: 'noc_501', a: 0 };
    const token = signedToken(payload, 'accounts-secret');
    let requestedUrl = '';
    const result = await verifyReceiptAcrossSystems(token, async (url, options) => {
      requestedUrl = url;
      assert.equal(options.headers.Accept, 'application/json');
      assert.ok(options.signal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true, receipt: payload }),
      };
    });

    assert.deepEqual(result, { valid: true, receipt: payload });
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.origin, 'https://accounts.example.test');
    assert.equal(parsed.pathname, '/receipts/verify');
    assert.equal(parsed.searchParams.get('token'), token);
  } finally {
    if (previousSecret === undefined) delete process.env.RECEIPT_VERIFY_SECRET;
    else process.env.RECEIPT_VERIFY_SECRET = previousSecret;
    if (previousAccountsUrl === undefined) delete process.env.ACCOUNTS_API_URL;
    else process.env.ACCOUNTS_API_URL = previousAccountsUrl;
  }
});

test('malformed token is rejected without an Accounts request', async () => {
  let fetchCalled = false;
  const result = await verifyReceiptAcrossSystems('not-json', async () => {
    fetchCalled = true;
  });
  assert.equal(result.valid, false);
  assert.equal(result.message, 'Malformed token');
  assert.equal(fetchCalled, false);
  assert.equal(verifyLocalReceiptToken('').message, 'Missing token');
});
