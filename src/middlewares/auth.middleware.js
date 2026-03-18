import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';

const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = verifyToken(token);
    const result = await pool.query(
      'SELECT id, email, role, site_id, is_active, token_version FROM users WHERE id = $1 LIMIT 1',
      [decoded.id],
    );
    const dbUser = result.rows[0];

    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ message: 'User not found or inactive' });
    }

    if (decoded.version !== undefined && dbUser.token_version !== decoded.version) {
      return res.status(401).json({ message: 'Session expired. Please login again.' });
    }

    let effectiveSiteId = dbUser.site_id || null;
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
      } else if (String(requestedSiteId) === String(dbUser.site_id || '')) {
        effectiveSiteId = requestedSiteId;
      }
    }

    req.user = {
      ...decoded,
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      site_id: effectiveSiteId,
    };
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

export default authMiddleware;