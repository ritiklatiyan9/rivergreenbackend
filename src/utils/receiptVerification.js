import crypto from 'crypto';

const DEFAULT_ACCOUNTS_API_URL = 'https://rgaccountbackend.onrender.com';
const ACCOUNTS_VERIFY_TIMEOUT_MS = 8000;

const decodeEnvelope = (token) => {
  try {
    if (!token) return { valid: false, message: 'Missing token' };
    const decoded = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (!decoded?.p || !decoded?.s || typeof decoded.s !== 'string') {
      return { valid: false, message: 'Malformed token' };
    }
    return { valid: true, payload: decoded.p, signature: decoded.s };
  } catch {
    return { valid: false, message: 'Malformed token' };
  }
};

/** Verify receipts issued by the Bookings service itself. */
export const verifyLocalReceiptToken = (token) => {
  const envelope = decodeEnvelope(token);
  if (!envelope.valid) return envelope;

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
    .update(JSON.stringify(envelope.payload))
    .digest('hex');
  const actual = Buffer.from(envelope.signature, 'hex');
  const expected = Buffer.from(expectedSignature, 'hex');

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return { valid: false, message: 'Invalid or tampered receipt', canTryAccounts: true };
  }

  return { valid: true, receipt: envelope.payload };
};

/**
 * defencegarden.com has one public verification page for two independently
 * secured systems. Verify Booking tokens locally; if the signature belongs to
 * Accounts, ask the Accounts backend to validate it with its own secret.
 */
export const verifyReceiptAcrossSystems = async (token, fetchImpl = globalThis.fetch) => {
  const local = verifyLocalReceiptToken(token);
  if (local.valid || !local.canTryAccounts) return local;

  if (typeof fetchImpl !== 'function') {
    return { valid: false, status: 503, message: 'Receipt verification is temporarily unavailable' };
  }

  const accountsBaseUrl = String(
    process.env.ACCOUNTS_API_URL || DEFAULT_ACCOUNTS_API_URL
  ).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACCOUNTS_VERIFY_TIMEOUT_MS);

  try {
    const response = await fetchImpl(
      `${accountsBaseUrl}/receipts/verify?token=${encodeURIComponent(String(token))}`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );
    const body = await response.json().catch(() => null);

    if (response.ok && body?.valid === true && body?.receipt) {
      return { valid: true, receipt: body.receipt };
    }
    if (response.status >= 500) {
      return { valid: false, status: 503, message: 'Receipt verification is temporarily unavailable' };
    }
    return { valid: false, message: body?.message || 'Invalid or tampered receipt' };
  } catch {
    return { valid: false, status: 503, message: 'Receipt verification is temporarily unavailable' };
  } finally {
    clearTimeout(timeout);
  }
};
