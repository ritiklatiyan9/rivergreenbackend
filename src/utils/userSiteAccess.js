let _ensurePromise = null;

export const ensureUserSiteAccessTable = async (pool) => {
  if (_ensurePromise) return _ensurePromise;

  _ensurePromise = (async () => {
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
  })().catch((error) => {
    _ensurePromise = null;
    throw error;
  });

  return _ensurePromise;
};

export const getUserAssignedSiteIds = async (
  userId,
  pool,
  { includePrimary = true, primarySiteId = undefined } = {},
) => {
  await ensureUserSiteAccessTable(pool);

  const rows = await pool.query(
    'SELECT site_id FROM user_site_access WHERE user_id = $1',
    [userId],
  );

  const ids = rows.rows.map((r) => String(r.site_id));

  if (includePrimary) {
    let resolvedPrimarySiteId = primarySiteId;
    if (resolvedPrimarySiteId === undefined) {
      const userRow = await pool.query('SELECT site_id FROM users WHERE id = $1 LIMIT 1', [userId]);
      resolvedPrimarySiteId = userRow.rows[0]?.site_id || null;
    }
    const normalizedPrimarySiteId = resolvedPrimarySiteId ? String(resolvedPrimarySiteId) : null;
    if (normalizedPrimarySiteId && !ids.includes(normalizedPrimarySiteId)) {
      ids.unshift(normalizedPrimarySiteId);
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

    if (normalized.length > 0) {
      await client.query(
        `INSERT INTO user_site_access (user_id, site_id)
         SELECT $1, selected.site_id FROM UNNEST($2::uuid[]) AS selected(site_id)
         ON CONFLICT (user_id, site_id) DO NOTHING`,
        [userId, normalized],
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
