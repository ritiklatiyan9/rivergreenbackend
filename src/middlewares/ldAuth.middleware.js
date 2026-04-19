// Lucky Draw auth middleware — completely independent from main auth.
// Reads Bearer token, verifies against ld_users table, rejects on any mismatch.
// Also ships helpers: requireLdRole, requirePermission, requireManager.

import { verifyLdAccessToken } from '../config/ldJwt.js';
import pool from '../config/db.js';

const MANAGER_ROLES = new Set(['PRIME_MANAGER', 'GENERAL_MANAGER']);
const LD_ROLES = new Set(['PRIME_MANAGER', 'GENERAL_MANAGER', 'LD_AGENT']);

export const ldAuth = async (req, res, next) => {
  try {
    const raw = req.header('Authorization') || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    let decoded;
    try {
      decoded = verifyLdAccessToken(token);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    if (!decoded?.id || !LD_ROLES.has(decoded.role)) {
      return res.status(401).json({ success: false, message: 'Invalid token payload' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, username, role, parent_id, site_id, is_active, permissions, token_version
         FROM ld_users WHERE id = $1 LIMIT 1`,
      [decoded.id],
    );
    const u = rows[0];
    if (!u || !u.is_active) return res.status(401).json({ success: false, message: 'Account inactive' });
    if (decoded.version !== undefined && u.token_version !== decoded.version) {
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    // allowedType is baked into the JWT at login time — no extra query needed
    req.ldUser = {
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      parentId: u.parent_id,
      siteId: u.site_id,
      permissions: u.permissions || {},
      allowedType: decoded.allowedType || null,
    };
    next();
  } catch (err) {
    console.error('[ldAuth] error', err);
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
};

export const requireLdRole = (...roles) => (req, res, next) => {
  if (!req.ldUser) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!roles.includes(req.ldUser.role)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  next();
};

export const requireManager = (req, res, next) => {
  if (!req.ldUser) return res.status(401).json({ success: false, message: 'Unauthorized' });
  if (!MANAGER_ROLES.has(req.ldUser.role)) {
    return res.status(403).json({ success: false, message: 'Managers only' });
  }
  next();
};

// Checks a permission flag. Managers implicitly have all permissions on
// their own data unless admin explicitly revokes them.
export const requirePermission = (perm) => (req, res, next) => {
  if (!req.ldUser) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const p = req.ldUser.permissions || {};
  if (p[perm] === true) return next();
  // Default-allow for managers on view/create; default-deny otherwise.
  if (MANAGER_ROLES.has(req.ldUser.role) && (perm === 'canView' || perm === 'canCreate')) return next();
  return res.status(403).json({ success: false, message: `Missing permission: ${perm}` });
};
