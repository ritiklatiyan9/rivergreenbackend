import { SIDEBAR_MODULE_KEYS, getDefaultModulesForRole, isValidModuleKey } from '../config/sidebarModules.js';

let _tableEnsured = false;

export const ensureSidebarPermissionsTable = async (pool) => {
  if (_tableEnsured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sidebar_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, module_key)
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_sidebar_permissions_user_id ON user_sidebar_permissions(user_id)');

  _tableEnsured = true;
};

// Returns the explicit module rows for a user (no fallback).
export const getStoredModulesForUser = async (userId, pool) => {
  await ensureSidebarPermissionsTable(pool);
  const result = await pool.query(
    'SELECT module_key FROM user_sidebar_permissions WHERE user_id = $1',
    [userId],
  );
  return result.rows.map((r) => r.module_key);
};

// Returns whether the user has any explicit permissions stored.
export const hasStoredModules = async (userId, pool) => {
  const rows = await getStoredModulesForUser(userId, pool);
  return rows.length > 0;
};

// Effective list of allowed module keys for a user — falls back to role defaults
// if the user has no explicit rows yet.
export const getEffectiveModulesForUser = async (user, pool) => {
  if (!user) return [];
  const stored = await getStoredModulesForUser(user.id, pool);
  if (stored.length > 0) return stored.filter(isValidModuleKey);
  return getDefaultModulesForRole(user.role);
};

// Replace the user's allowed modules with the given list.
export const setModulesForUser = async (userId, moduleKeys, pool) => {
  await ensureSidebarPermissionsTable(pool);

  const normalized = [...new Set((Array.isArray(moduleKeys) ? moduleKeys : [])
    .filter((key) => typeof key === 'string')
    .map((key) => key.trim())
    .filter((key) => isValidModuleKey(key)))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_sidebar_permissions WHERE user_id = $1', [userId]);
    for (const key of normalized) {
      await client.query(
        'INSERT INTO user_sidebar_permissions (user_id, module_key) VALUES ($1, $2) ON CONFLICT (user_id, module_key) DO NOTHING',
        [userId, key],
      );
    }
    await client.query('COMMIT');
    return normalized;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export { SIDEBAR_MODULE_KEYS };
