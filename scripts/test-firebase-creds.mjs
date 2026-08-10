/**
 * Firebase credential parsing self-check.
 *
 * Reproduces the shapes a deploy dashboard actually produces — clean JSON, a
 * value whose backslashes got re-escaped (the "DECODER routines::unsupported"
 * failure), base64, and a quote-wrapped paste — and asserts each one yields a
 * usable PEM. Run: node scripts/test-firebase-creds.mjs
 */
import assert from 'node:assert';

const SAMPLE = {
  type: 'service_account',
  project_id: 'ticsign',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n',
  client_email: 'x@ticsign.iam.gserviceaccount.com',
};

const clean = JSON.stringify(SAMPLE);
const cases = {
  'plain json':        clean,
  'escaped newlines':  clean.replace(/\\n/g, '\\\\n'), // what Render stored
  'base64':            Buffer.from(clean).toString('base64'),
  'quote wrapped':     `'${clean}'`,
  'padded':            `  ${clean}  `,
};

for (const [label, value] of Object.entries(cases)) {
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = value;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  // Import fresh each time: the service memoises its init attempt.
  const { parseServiceAccountForTest } = await import(`../src/services/fcm.service.js?t=${label}`);
  const creds = parseServiceAccountForTest();

  assert.ok(creds, `${label}: returned null`);
  assert.strictEqual(creds.project_id, 'ticsign', `${label}: wrong project`);
  assert.ok(
    creds.private_key.includes('\n') && !creds.private_key.includes('\\n'),
    `${label}: private_key still has literal \\n — OpenSSL would reject this`,
  );
  console.log(`ok  ${label}`);
}

// Base64 via its own variable.
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.FIREBASE_SERVICE_ACCOUNT_B64 = Buffer.from(clean).toString('base64');
const { parseServiceAccountForTest } = await import('../src/services/fcm.service.js?t=b64var');
assert.strictEqual(parseServiceAccountForTest().project_id, 'ticsign', 'B64 var: failed');
console.log('ok  base64 via FIREBASE_SERVICE_ACCOUNT_B64');

console.log('\nAll credential shapes parse to a valid PEM.');
