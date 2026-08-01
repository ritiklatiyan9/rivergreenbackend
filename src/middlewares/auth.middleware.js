import { verifyToken } from '../config/jwt.js';
import pool from '../config/db.js';
import { ensureUserSiteAccessTable } from '../utils/userSiteAccess.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const resolveEffectiveSiteId = ({
  role,
  primarySiteId,
  assignedSiteIds = [],
  requestedSiteId,
  requestedSiteActive = false,
  ownerHasRequestedSite = false,
  supervisorHasRequestedSite = false,
}) => {
  const normalizedAssigned = [...new Set(assignedSiteIds.filter(Boolean).map(String))];
  const primary = primarySiteId ? String(primarySiteId) : null;
  if (primary && !normalizedAssigned.includes(primary)) normalizedAssigned.unshift(primary);

  let effectiveSiteId = primary || normalizedAssigned[0] || null;
  if (!requestedSiteId || !requestedSiteActive) return effectiveSiteId;

  const requested = String(requestedSiteId);
  if (role === 'OWNER' && ownerHasRequestedSite) return requested;
  if (role === 'SUPERVISOR' && supervisorHasRequestedSite) return requested;
  if (role !== 'OWNER' && role !== 'SUPERVISOR' && normalizedAssigned.includes(requested)) {
    return requested;
  }

  return effectiveSiteId;
};

const authMiddleware = async (req, res, next) => {
  const authorization = req.header('Authorization') || '';
  const [scheme, token] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  const requestedSiteId = req.header('x-site-id') || null;
  if (requestedSiteId && !UUID_PATTERN.test(requestedSiteId)) {
    return res.status(400).json({ success: false, message: 'Invalid site identifier' });
  }

  try {
    await ensureUserSiteAccessTable(pool);
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, u.site_id, u.team_id, u.is_active, u.token_version,
              COALESCE((
                SELECT ARRAY_AGG(usa.site_id::text ORDER BY usa.created_at ASC)
                FROM user_site_access usa
                JOIN sites assigned_site ON assigned_site.id = usa.site_id
                WHERE usa.user_id = u.id
                  AND assigned_site.is_active = TRUE
                  AND (u.role <> 'OWNER' OR assigned_site.created_by = u.id)
              ), ARRAY[]::text[]) AS assigned_site_ids,
              CASE WHEN u.site_id IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM sites primary_site
                WHERE primary_site.id = u.site_id
                  AND primary_site.is_active = TRUE
                  AND (u.role <> 'OWNER' OR primary_site.created_by = u.id)
              ) END AS primary_site_active,
              CASE WHEN $2::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM sites s WHERE s.id = $2::uuid AND s.is_active = TRUE
              ) END AS requested_site_active,
              CASE WHEN $2::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM sites owner_site
                WHERE owner_site.id = $2::uuid
                  AND owner_site.is_active = TRUE
                  AND owner_site.created_by = u.id
              ) END AS owner_has_requested_site,
              CASE WHEN $2::uuid IS NULL THEN FALSE ELSE EXISTS (
                SELECT 1 FROM supervisor_site_access ssa
                JOIN sites supervisor_site ON supervisor_site.id = ssa.site_id
                WHERE ssa.supervisor_id = u.id
                  AND ssa.site_id = $2::uuid
                  AND supervisor_site.is_active = TRUE
              ) END AS supervisor_has_requested_site
       FROM users u
       WHERE u.id = $1
       LIMIT 1`,
      [decoded.id, requestedSiteId],
    );
    const dbUser = result.rows[0];

    if (!dbUser || !dbUser.is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }

    if (decoded.version !== undefined && dbUser.token_version !== decoded.version) {
      return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
    }

    const assignedSiteIds = (dbUser.assigned_site_ids || []).map(String);
    const primarySiteId = dbUser.primary_site_active && dbUser.site_id
      ? String(dbUser.site_id)
      : null;
    const effectiveSiteId = resolveEffectiveSiteId({
      role: dbUser.role,
      primarySiteId,
      assignedSiteIds,
      requestedSiteId,
      requestedSiteActive: dbUser.requested_site_active,
      ownerHasRequestedSite: dbUser.owner_has_requested_site,
      supervisorHasRequestedSite: dbUser.supervisor_has_requested_site,
    });

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
    next(err);
  }
};

export default authMiddleware;
