import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import userModel from '../models/User.model.js';
import { SIDEBAR_MODULES, getDefaultModulesForRole } from '../config/sidebarModules.js';
import {
  ensureSidebarPermissionsTable,
  getStoredModulesForUser,
  getEffectiveModulesForUser,
  setModulesForUser,
} from '../utils/sidebarPermissions.js';

// Returns the catalog of modules that admin can toggle per user.
export const getModuleCatalog = asyncHandler(async (req, res) => {
  res.json({ success: true, modules: SIDEBAR_MODULES });
});

// Returns all panel-relevant users with their sidebar module configuration.
export const listUsersWithSidebarPermissions = asyncHandler(async (req, res) => {
  await ensureSidebarPermissionsTable(pool);

  const params = [];
  let where = `WHERE u.role IN ('ADMIN', 'SUPERVISOR')`;

  // Admins are scoped to their own site; OWNER sees everyone.
  if (req.user.role === 'ADMIN' && req.user.site_id) {
    params.push(req.user.site_id);
    where += ` AND u.site_id = $${params.length}`;
  }

  const result = await pool.query(
    `
      SELECT
        u.id, u.name, u.email, u.role, u.site_id, u.is_active,
        s.name AS site_name,
        COALESCE(
          ARRAY_AGG(usp.module_key) FILTER (WHERE usp.module_key IS NOT NULL),
          ARRAY[]::text[]
        ) AS stored_modules
      FROM users u
      LEFT JOIN sites s ON s.id = u.site_id
      LEFT JOIN user_sidebar_permissions usp ON usp.user_id = u.id
      ${where}
      GROUP BY u.id, u.name, u.email, u.role, u.site_id, u.is_active, s.name
      ORDER BY u.role, u.name ASC
    `,
    params,
  );

  const users = result.rows.map((u) => {
    const stored = Array.isArray(u.stored_modules) ? u.stored_modules : [];
    const allowed = stored.length > 0 ? stored : getDefaultModulesForRole(u.role);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      site_id: u.site_id,
      site_name: u.site_name,
      is_active: u.is_active,
      // `customized` tells the UI whether this user has had their modules
      // explicitly set, vs. just inheriting role defaults.
      customized: stored.length > 0,
      allowed_modules: allowed,
    };
  });

  res.json({ success: true, users });
});

// Returns the resolved permissions for a specific user.
export const getUserSidebarPermissions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await userModel.findByIdSafe(id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (req.user.role === 'ADMIN' && String(user.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this user' });
  }

  const stored = await getStoredModulesForUser(id, pool);
  const allowed = stored.length > 0 ? stored : getDefaultModulesForRole(user.role);

  res.json({
    success: true,
    user_id: user.id,
    role: user.role,
    customized: stored.length > 0,
    allowed_modules: allowed,
  });
});

// Replace the user's allowed sidebar modules.
export const updateUserSidebarPermissions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { module_keys } = req.body;

  if (!Array.isArray(module_keys)) {
    return res.status(400).json({ success: false, message: 'module_keys must be an array' });
  }

  const user = await userModel.findByIdSafe(id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (user.role === 'OWNER') {
    return res.status(403).json({ success: false, message: 'Cannot modify sidebar permissions for OWNER' });
  }
  if (req.user.role === 'ADMIN' && String(user.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this user' });
  }

  const saved = await setModulesForUser(id, module_keys, pool);

  res.json({
    success: true,
    message: 'Sidebar permissions updated',
    user_id: id,
    allowed_modules: saved,
  });
});

// Returns the current logged-in user's effective sidebar modules.
export const getMySidebarModules = asyncHandler(async (req, res) => {
  const user = await userModel.findByIdSafe(req.user.id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const allowed = await getEffectiveModulesForUser(user, pool);
  res.json({ success: true, allowed_modules: allowed });
});
