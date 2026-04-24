import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import pool from '../config/db.js';

// ── Firebase Admin bootstrap ──────────────────────────────────────────────
// Supports three config styles (choose whichever is easiest on deploy):
//   1. FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON string pasted into env
//   2. GOOGLE_APPLICATION_CREDENTIALS — absolute path to the JSON file
//   3. File at ./firebase-service-account.json relative to process.cwd()
let _app = null;
let _initTried = false;
let _initError = null;

const tryParseInline = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { _initError = new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`); return null; }
};

const tryReadFile = () => {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    path.resolve(process.cwd(), 'firebase-service-account.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      _initError = new Error(`Failed to read Firebase credentials at ${file}: ${e.message}`);
    }
  }
  return null;
};

const init = () => {
  if (_app || _initTried) return _app;
  _initTried = true;

  const creds = tryParseInline() || tryReadFile();
  if (!creds) {
    if (!_initError) _initError = new Error('No Firebase service account configured — push notifications disabled');
    console.warn('[fcm] ' + _initError.message);
    return null;
  }

  try {
    _app = admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
    console.log(`[fcm] Initialized for project ${creds.project_id}`);
    return _app;
  } catch (e) {
    _initError = e;
    console.error('[fcm] initializeApp failed:', e.message);
    return null;
  }
};

// ── Token storage helpers ─────────────────────────────────────────────────
// Lazy-create the table on first touch so deploys don't need a separate
// migration step (same pattern as ensureUserSiteAccessTable).
let _tableEnsured = false;
const ensureTable = async () => {
  if (_tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_fcm_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      platform   TEXT NOT NULL DEFAULT 'android',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_user_id ON user_fcm_tokens (user_id)');
  _tableEnsured = true;
};

export const upsertToken = async (userId, token, platform = 'android') => {
  if (!userId || !token) return;
  await ensureTable();
  await pool.query(
    `INSERT INTO user_fcm_tokens (user_id, token, platform, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token) DO UPDATE SET
       user_id    = EXCLUDED.user_id,
       platform   = EXCLUDED.platform,
       updated_at = NOW()`,
    [userId, token, platform],
  );
};

export const deleteToken = async (token) => {
  if (!token) return;
  await ensureTable();
  await pool.query('DELETE FROM user_fcm_tokens WHERE token = $1', [token]);
};

export const deleteTokensForUser = async (userId) => {
  if (!userId) return;
  await ensureTable();
  await pool.query('DELETE FROM user_fcm_tokens WHERE user_id = $1', [userId]);
};

const getTokensForUsers = async (userIds) => {
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  await ensureTable();
  const res = await pool.query(
    'SELECT token FROM user_fcm_tokens WHERE user_id = ANY($1::uuid[])',
    [ids],
  );
  return res.rows.map((r) => r.token).filter(Boolean);
};

// ── Public send API ───────────────────────────────────────────────────────
/**
 * Send a push notification to a list of users. Fails softly if FCM isn't
 * configured so chat delivery never breaks.
 *
 * `data` becomes the payload available to the app on tap:
 *   { type: 'chat', conversation_id, sender_name, preview, route }
 */
export const sendToUsers = async (userIds, { title, body, data = {} }) => {
  const app = init();
  if (!app) return { ok: false, reason: 'fcm-not-configured' };

  const tokens = await getTokensForUsers(userIds);
  if (tokens.length === 0) return { ok: true, sent: 0 };

  // FCM requires data values to be strings.
  const stringData = Object.fromEntries(
    Object.entries(data || {}).map(([k, v]) => [k, v == null ? '' : String(v)]),
  );

  const message = {
    tokens,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        channelId: 'chat_messages',
        sound: 'notification_bell',
        defaultVibrateTimings: true,
        clickAction: 'FCM_PLUGIN_ACTIVITY',
      },
    },
    apns: {
      payload: {
        aps: { sound: 'notification_bell.caf', badge: 1 },
      },
    },
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(message);

    // Clean up dead tokens so we stop spraying them.
    if (resp.failureCount > 0) {
      const dead = [];
      resp.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            dead.push(tokens[i]);
          }
        }
      });
      if (dead.length) {
        await pool.query('DELETE FROM user_fcm_tokens WHERE token = ANY($1::text[])', [dead]);
      }
    }

    return { ok: true, sent: resp.successCount, failed: resp.failureCount };
  } catch (e) {
    console.error('[fcm] send failed:', e.message);
    return { ok: false, reason: e.message };
  }
};

export default { upsertToken, deleteToken, deleteTokensForUser, sendToUsers };
