let _tableEnsured = false;

export const ensureUserSiteAccessTable = async (pool) => {
  if (_tableEnsured) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_site_access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, site_id)
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_site_access_user_id ON user_site_access(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_site_access_site_id ON user_site_access(site_id)');

  _tableEnsured = true;
};

export const getUserAssignedSiteIds = async (userId, pool, { includePrimary = true } = {}) => {
  await ensureUserSiteAccessTable(pool);

  const rows = await pool.query(
    'SELECT site_id FROM user_site_access WHERE user_id = $1',
    [userId],
  );

  const ids = rows.rows.map((r) => String(r.site_id));

  if (includePrimary) {
    const userRow = await pool.query('SELECT site_id FROM users WHERE id = $1 LIMIT 1', [userId]);
    const primarySiteId = userRow.rows[0]?.site_id ? String(userRow.rows[0].site_id) : null;
    if (primarySiteId && !ids.includes(primarySiteId)) {
      ids.unshift(primarySiteId);
    }
  }

  return [...new Set(ids)];
};

export const setUserAssignedSites = async (userId, siteIds, pool) => {
  await ensureUserSiteAccessTable(pool);

  const normalized = [...new Set((Array.isArray(siteIds) ? siteIds : [])
    .filter(Boolean)
    .map((id) => String(id)))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM user_site_access WHERE user_id = $1', [userId]);

    for (const siteId of normalized) {
      await client.query(
        'INSERT INTO user_site_access (user_id, site_id) VALUES ($1, $2) ON CONFLICT (user_id, site_id) DO NOTHING',
        [userId, siteId],
      );
    }

    const primarySiteId = normalized[0] || null;
    await client.query('UPDATE users SET site_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, primarySiteId]);

    await client.query('COMMIT');
    return { primarySiteId, assignedSiteIds: normalized };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
