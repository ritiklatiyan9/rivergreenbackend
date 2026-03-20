import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword, comparePassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { ensureUserSiteAccessTable, setUserAssignedSites } from '../utils/userSiteAccess.js';

const sanitizeUser = (user) => {
  const { password, refresh_token, token_version, ...safe } = user;
  return safe;
};

// ============================================================
// SITE MANAGEMENT (Owner only)
// ============================================================

// Create a new site
export const createSite = asyncHandler(async (req, res) => {
  const { name, address, city, state, description } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Site name is required' });
  }

  const siteData = {
    name,
    address: address || null,
    city: city || null,
    state: state || null,
    description: description || null,
    created_by: req.user.id,
  };

  const site = await siteModel.create(siteData, pool);
  bustCache('cache:*:/api/admin/*');
  res.status(201).json({ success: true, site });
});

// List all sites for owner
export const listSites = asyncHandler(async (req, res) => {
  let sites;
  if (req.user.role === 'OWNER') {
    sites = await siteModel.findWithAdminCount(req.user.id, pool);
  } else {
    const query = `
      SELECT s.*,
        (SELECT COUNT(*) FROM users u WHERE u.site_id = s.id AND u.role = 'ADMIN') as admin_count,
        (SELECT COUNT(*) FROM users u WHERE u.site_id = s.id) as total_users
      FROM sites s
      ORDER BY s.created_at DESC
    `;
    const result = await pool.query(query);
    sites = result.rows;
  }
  res.json({ success: true, sites });
});

// Update site
export const updateSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, address, city, state, description, is_active } = req.body;

  const site = await siteModel.findById(id, pool);
  if (!site) {
    return res.status(404).json({ success: false, message: 'Site not found' });
  }
  if (req.user.role === 'OWNER' && site.created_by && site.created_by !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You do not have access to this site' });
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (address !== undefined) updateData.address = address;
  if (city !== undefined) updateData.city = city;
  if (state !== undefined) updateData.state = state;
  if (description !== undefined) updateData.description = description;
  if (is_active !== undefined) updateData.is_active = is_active;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: 'No data to update' });
  }

  const updated = await siteModel.update(id, updateData, pool);
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, site: updated });
});

// Delete site
export const deleteSite = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const site = await siteModel.findById(id, pool);
  if (!site) {
    return res.status(404).json({ success: false, message: 'Site not found' });
  }
  if (req.user.role === 'OWNER' && site.created_by && site.created_by !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You do not have access to this site' });
  }

  const usersResult = await pool.query('SELECT COUNT(*)::int AS count FROM users WHERE site_id = $1', [id]);
  const usersCount = usersResult.rows[0]?.count || 0;
  if (usersCount > 0) {
    return res.status(400).json({
      success: false,
      message: `Cannot delete site with ${usersCount} assigned users. Reassign users first.`,
    });
  }

  await siteModel.delete(id, pool);
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, message: 'Site deleted successfully' });
});

// Get site count
export const getSiteCount = asyncHandler(async (req, res) => {
  const count = await siteModel.countByOwner(req.user.id, pool);
  res.json({ success: true, count });
});

// ============================================================
// ADMIN MANAGEMENT (Owner only - assign admin to a site)
// ============================================================

// Create Admin and assign to a site
export const createAdmin = asyncHandler(async (req, res) => {
  const { name, email, password, phone, site_id } = req.body;
  const targetSiteId = site_id || req.user.site_id;
  if (!name || !email || !password || !targetSiteId) {
    return res.status(400).json({ success: false, message: 'Name, email, password and site_id are required' });
  }

  const site = await siteModel.findById(targetSiteId, pool);
  if (!site) {
    return res.status(404).json({ success: false, message: 'Site not found' });
  }
  if (req.user.role === 'OWNER' && site.created_by && site.created_by !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You do not have access to this site' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ success: false, message: 'Email already exists' });

  const sponsorCode = await userModel.getUniqueSponsorCode(pool);
  const hashedPassword = await hashPassword(password);

  const userData = {
    name,
    email,
    phone: phone || null,
    password: hashedPassword,
    role: 'ADMIN',
    site_id: targetSiteId,
    sponsor_code: sponsorCode,
    sponsor_id: null,
    parent_id: null,
    token_version: 1,
  };

  const admin = await userModel.create(userData, pool);
  bustCache('cache:*:/api/admin/*');
  res.status(201).json({ success: true, admin: sanitizeUser(admin) });
});

// List all Admins (Owner only)
export const listAdmins = asyncHandler(async (req, res) => {
  let admins = await userModel.findAllByRole('ADMIN', pool);
  if (req.user.role === 'ADMIN') {
    admins = admins.filter((admin) => String(admin.site_id || '') === String(req.user.site_id || ''));
  }

  // Enrich with site name
  const enriched = [];
  for (const admin of admins) {
    let siteName = null;
    if (admin.site_id) {
      const site = await siteModel.findById(admin.site_id, pool);
      siteName = site?.name || null;
    }
    enriched.push({ ...admin, site_name: siteName });
  }

  res.json({ success: true, admins: enriched });
});

// Update Admin (Owner only)
export const updateAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, password, phone, site_id, is_active } = req.body;

  const admin = await userModel.findById(id, pool);
  if (!admin || admin.role !== 'ADMIN') {
    return res.status(404).json({ success: false, message: 'Admin not found' });
  }

  if (req.user.role === 'ADMIN' && String(admin.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this admin' });
  }

  let updateData = {};
  if (name) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (is_active !== undefined) updateData.is_active = is_active;
  if (email) {
    const existing = await userModel.findByEmail(email, pool);
    if (existing && existing.id !== id) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    updateData.email = email;
  }
  if (password) updateData.password = await hashPassword(password);
  if (site_id) {
    const site = await siteModel.findById(site_id, pool);
    if (!site) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }
    if (req.user.role === 'OWNER' && site.created_by && site.created_by !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You do not have access to this site' });
    }
    if (req.user.role === 'ADMIN' && String(site.id) !== String(req.user.site_id || '')) {
      return res.status(403).json({ success: false, message: 'You can only assign your current site' });
    }
    updateData.site_id = site_id;
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: 'No data to update' });
  }

  const updated = await userModel.update(id, updateData, pool);
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, admin: sanitizeUser(updated) });
});

// Delete Admin (Owner only)
export const deleteAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const admin = await userModel.findById(id, pool);
  if (!admin || admin.role !== 'ADMIN') {
    return res.status(404).json({ success: false, message: 'Admin not found' });
  }

  if (req.user.role === 'ADMIN' && String(admin.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this admin' });
  }

  await userModel.delete(id, pool);
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, message: 'Admin deleted successfully' });
});

// Get admin count
export const getAdminCount = asyncHandler(async (req, res) => {
  const count = await userModel.countByRole('ADMIN', pool);
  res.json({ success: true, count });
});

// Owner dashboard stats
export const getOwnerStats = asyncHandler(async (req, res) => {
  const siteCount = await siteModel.countByOwner(req.user.id, pool);
  const adminCount = await userModel.countByRole('ADMIN', pool);
  const sites = await siteModel.findWithAdminCount(req.user.id, pool);

  res.json({
    success: true,
    stats: {
      total_sites: siteCount,
      total_admins: adminCount,
      sites,
    },
  });
});

// ============================================================
// USER ACCESS MANAGEMENT (Account Access & Site Assignments)
// ============================================================

// Get all users for access management (exclude owner)
export const getAllUsersForAccess = asyncHandler(async (req, res) => {
  await ensureUserSiteAccessTable(pool);

  const query = `
    SELECT 
      u.id, u.name, u.email, u.role, u.site_id, u.is_active, u.created_at,
      s.name as site_name,
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT('id', assigned_s.id, 'name', assigned_s.name)
        ) FILTER (WHERE assigned_s.id IS NOT NULL),
        '[]'::json
      ) AS assigned_sites,
      COALESCE(
        ARRAY_AGG(DISTINCT usa.site_id) FILTER (WHERE usa.site_id IS NOT NULL),
        ARRAY[]::uuid[]
      ) AS assigned_site_ids,
      (SELECT COUNT(*)::int FROM leads WHERE assigned_to = u.id) as lead_count,
      (SELECT COUNT(*)::int FROM calls WHERE assigned_to = u.id) as call_count
    FROM users u
    LEFT JOIN sites s ON u.site_id = s.id
    LEFT JOIN user_site_access usa ON usa.user_id = u.id
    LEFT JOIN sites assigned_s ON assigned_s.id = usa.site_id
    WHERE u.role != 'OWNER'
    GROUP BY u.id, u.name, u.email, u.role, u.site_id, u.is_active, u.created_at, s.name
    ORDER BY u.created_at DESC
  `;
  const result = await pool.query(query);
  res.json({ success: true, users: result.rows });
});

// Update user account access (enable/disable)
export const updateUserAccountAccess = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (is_active === undefined) {
    return res.status(400).json({ success: false, message: 'is_active is required' });
  }

  const user = await userModel.findById(id, pool);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Prevent disabling owner accounts
  if (user.role === 'OWNER') {
    return res.status(403).json({ success: false, message: 'Cannot disable owner account' });
  }

  // Admin can only manage users in their site
  if (req.user.role === 'ADMIN' && String(user.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this user' });
  }

  const nextIsActive = typeof is_active === 'boolean'
    ? is_active
    : String(is_active).toLowerCase() === 'true';

  const updatePayload = { is_active: nextIsActive };
  if (!nextIsActive) {
    updatePayload.refresh_token = null;
    updatePayload.token_version = (user.token_version || 0) + 1;
  }

  await userModel.update(id, updatePayload, pool);
  await bustCache('cache:*:/api/admin/*');
  
  res.json({
    success: true,
    message: `User account ${nextIsActive ? 'enabled' : 'disabled'} successfully`,
    user: sanitizeUser(await userModel.findById(id, pool)),
  });
});

// Update user site assignments and access
export const updateUserSiteAccess = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { site_id, site_ids } = req.body;

  await ensureUserSiteAccessTable(pool);

  const user = await userModel.findById(id, pool);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Prevent changing owner's site
  if (user.role === 'OWNER') {
    return res.status(403).json({ success: false, message: 'Cannot change owner site assignment' });
  }

  const incomingSiteIds = Array.isArray(site_ids)
    ? site_ids
    : (site_id ? [site_id] : []);

  const normalizedSiteIds = [...new Set(incomingSiteIds
    .filter(Boolean)
    .map((v) => String(v)))];

  // Validate all requested sites exist
  for (const nextSiteId of normalizedSiteIds) {
    const site = await siteModel.findById(nextSiteId, pool);
    if (!site) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }
  }

  const assigned = await setUserAssignedSites(id, normalizedSiteIds, pool);
  await bustCache('cache:*:/api/admin/*');

  const updated = await userModel.findById(id, pool);
  res.json({
    success: true,
    message: 'User site assignments updated',
    user: sanitizeUser(updated),
    assigned_site_ids: assigned.assignedSiteIds,
    primary_site_id: assigned.primarySiteId,
  });
});

// Reset user password (admin sets temporary password)
export const resetUserPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { temporary_password } = req.body;

  if (!temporary_password || temporary_password.length < 6) {
    return res.status(400).json({ success: false, message: 'Temporary password must be at least 6 characters' });
  }

  const user = await userModel.findById(id, pool);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Prevent resetting owner password
  if (user.role === 'OWNER') {
    return res.status(403).json({ success: false, message: 'Cannot reset owner password' });
  }

  // Admin can only reset passwords for users in their site
  if (req.user.role === 'ADMIN' && String(user.site_id || '') !== String(req.user.site_id || '')) {
    return res.status(403).json({ success: false, message: 'You do not have access to this user' });
  }

  const hashedPassword = await hashPassword(temporary_password);
  await userModel.update(id, { password: hashedPassword }, pool);
  await bustCache('cache:*:/api/admin/*');

  res.json({
    success: true,
    message: 'User password reset successfully',
    user: sanitizeUser(await userModel.findById(id, pool)),
  });
});

// Change own password (authenticated user)
export const changeOwnPassword = asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, message: 'Current and new password are required' });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters' });
  }

  const user = await userModel.findById(req.user.id, pool);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Verify current password
  const valid = await comparePassword(current_password, user.password);
  if (!valid) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  const hashedPassword = await hashPassword(new_password);
  await userModel.update(req.user.id, { password: hashedPassword }, pool);
  await bustCache('cache:*:/api/admin/*');

  res.json({
    success: true,
    message: 'Password changed successfully',
  });
});
