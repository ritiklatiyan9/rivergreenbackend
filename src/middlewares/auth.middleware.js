import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';
import { ensureUserSiteAccessTable, getUserAssignedSiteIds } from '../utils/userSiteAccess.js';

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const result = await pool.query(
      'SELECT id, email, role, site_id, team_id, is_active, token_version FROM users WHERE id = $1 LIMIT 1',
      [decoded.id],
    );
    const dbUser = result.rows[0];

    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'User not found or inactive' });
    }

    if (decoded.version !== undefined && dbUser.token_version !== decoded.version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    await ensureUserSiteAccessTable(pool);
    const assignedSiteIds = await getUserAssignedSiteIds(dbUser.id, pool, { includePrimary: true });

    let effectiveSiteId = dbUser.site_id || null;
    if (!effectiveSiteId && assignedSiteIds.length > 0) {
      effectiveSiteId = assignedSiteIds[0];
    }

    const requestedSiteId = req.header('x-site-id') || null;

    if (requestedSiteId) {
      if (dbUser.role === 'OWNER' || dbUser.role === 'ADMIN') {
        const siteCheck = await pool.query(
          'SELECT id FROM sites WHERE id = $1 AND is_active = true LIMIT 1',
          [requestedSiteId],
        );
        if (siteCheck.rows[0]) {
          effectiveSiteId = siteCheck.rows[0].id;
        }
      } else if (dbUser.role === 'SUPERVISOR') {
        // Supervisor: check supervisor_site_access
        const ssaCheck = await pool.query(
          'SELECT site_id FROM supervisor_site_access WHERE supervisor_id = $1 AND site_id = $2 LIMIT 1',
          [dbUser.id, requestedSiteId],
        );
        if (ssaCheck.rows[0]) {
          effectiveSiteId = ssaCheck.rows[0].site_id;
        }
      } else if (assignedSiteIds.includes(String(requestedSiteId))) {
        effectiveSiteId = requestedSiteId;
      }
    }

    req.user = {
      ...decoded,
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      site_id: effectiveSiteId,
      team_id: dbUser.team_id || null,
    };
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

export default authMiddleware;