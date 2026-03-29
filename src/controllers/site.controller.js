import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import userProfileModel from '../models/UserProfile.model.js';
import teamModel from '../models/Team.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const sanitizeUser = (user) => {
  const { password, refresh_token, token_version, ...safe } = user;
  return safe;
};

const VALID_ROLES = ['TEAM_HEAD', 'AGENT'];

// ============================================================
// USER MANAGEMENT (Admin manages users within their site)
// ============================================================

// Get current admin's site info
export const getMySite = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user || !user.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const site = await siteModel.findById(user.site_id, pool);
  if (!site) {
    return res.status(404).json({ success: false, message: 'Site not found' });
  }

  res.json({ success: true, site });
});

// Get dashboard stats for admin's site
export const getSiteStats = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user || !user.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const stats = await userModel.getSiteStats(user.site_id, pool);
  const site = await siteModel.findById(user.site_id, pool);

  res.json({
    success: true,
    stats: {
      ...stats,
      site_name: site?.name,
      site_id: user.site_id,
    },
  });
});

// List all users in admin's site (with optional role filter)
export const listSiteUsers = asyncHandler(async (req, res) => {
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const { role } = req.query;

  let users;
  if (role && VALID_ROLES.includes(role)) {
    users = await userModel.findBySiteAndRole(adminUser.site_id, role, pool);
  } else {
    users = await userModel.findBySite(adminUser.site_id, pool);
  }

  res.json({ success: true, users });
});

// Get single user with profile data
export const getSiteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  // Use a custom query here to join with user_profiles easily
  const query = `
    SELECT u.id, u.name, u.email, u.phone, u.profile_photo, u.role, u.sponsor_code, u.sponsor_id, u.parent_id, u.is_active, u.created_at, u.updated_at,
           up.category_id, up.profile_data
    FROM users u
    LEFT JOIN user_profiles up ON u.id = up.user_id
    WHERE u.id = $1 AND u.site_id = $2
  `;
  const result = await pool.query(query, [id, adminUser.site_id]);

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'User not found in your site' });
  }

  res.json({ success: true, user: result.rows[0] });
});

// Create a user in admin's site
export const createSiteUser = asyncHandler(async (req, res) => {
  const {
    name,
    email,
    password,
    phone,
    role,
    sponsor_code: sponsorRefCode,
    category_id,
    profile_data,
    alternate_mobile,
    account_status,
    profile_photo,
    team_id,
    new_team_name,
  } = req.body;
  const sponsorRef = sponsorRefCode ? String(sponsorRefCode).trim() : null;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'Name, email, password and role are required' });
  }

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
  }

  if (team_id && new_team_name) {
    return res.status(400).json({ success: false, message: 'Provide either team_id or new_team_name, not both' });
  }

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) {
    return res.status(400).json({ success: false, message: 'Email already exists' });
  }

  // Generate unique sponsor code for the new user
  const newSponsorCode = await userModel.getUniqueSponsorCode(pool);
  const hashedPassword = await hashPassword(password);

  // Determine sponsor and parent based on role hierarchy
  let sponsorId = null;
  let parentId = null;

  if (sponsorRef) {
    const sponsor = await userModel.findBySponsorCode(sponsorRef, pool);
    if (!sponsor) {
      return res.status(400).json({ success: false, message: 'Invalid sponsor code' });
    }
    if (sponsor.site_id !== adminUser.site_id) {
      return res.status(400).json({ success: false, message: 'Sponsor does not belong to this site' });
    }
    sponsorId = sponsor.id;
    parentId = sponsor.id;
  } else {
    parentId = adminUser.id;
    sponsorId = adminUser.id;
  }

  let resolvedTeamId = null;
  if (team_id) {
    const existingTeam = await teamModel.findByIdAndSite(team_id, adminUser.site_id, pool);
    if (!existingTeam) {
      return res.status(404).json({ success: false, message: 'Selected team not found in your site' });
    }
    resolvedTeamId = existingTeam.id;
  } else if (new_team_name && String(new_team_name).trim()) {
    const tName = String(new_team_name).trim();
    const existingTeam = await teamModel.findByNameAndSite(tName, adminUser.site_id, pool);
    if (existingTeam) {
      return res.status(400).json({ success: false, message: `Team "${tName}" already exists.` });
    }
    const createdTeam = await teamModel.create({
      name: tName,
      site_id: adminUser.site_id,
      head_id: null,
    }, pool);
    resolvedTeamId = createdTeam.id;
  }

  const userData = {
    name,
    email,
    phone: phone || null,
    password: hashedPassword,
    role,
    site_id: adminUser.site_id,
    sponsor_code: newSponsorCode,
    sponsor_id: sponsorId,
    parent_id: parentId,
    team_id: resolvedTeamId,
    token_version: 1,
    alternate_mobile: alternate_mobile || null,
    account_status: account_status || 'Active',
    profile_photo: profile_photo || null,
    created_by: req.user.id,
  };

  const newUser = await userModel.create(userData, pool);

  if (role === 'TEAM_HEAD' && resolvedTeamId) {
    await teamModel.update(resolvedTeamId, { head_id: newUser.id }, pool);
    // Also insert into team_heads junction table
    await pool.query(
      'INSERT INTO team_heads (team_id, user_id) VALUES ($1, $2) ON CONFLICT (team_id, user_id) DO NOTHING',
      [resolvedTeamId, newUser.id]
    );
  }

  // Save extended profile data if provided
  if (category_id && profile_data) {
    await userProfileModel.upsertByUserId(
      newUser.id,
      adminUser.site_id,
      category_id,
      profile_data,
      pool
    );
  }

  bustCache('cache:*:/api/site/*');
  bustCache('cache:*:/api/teams*');
  res.status(201).json({ success: true, user: sanitizeUser(newUser) });
});

// Update a user in admin's site
export const updateSiteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, password, phone, role, is_active, sponsor_code: sponsorRefCode, profile_photo, category_id, profile_data, team_id } = req.body;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const targetUser = await userModel.findById(id, pool);
  if (!targetUser || targetUser.site_id !== adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'User not found in your site' });
  }

  // Check authorization: allow if self-edit, block if trying to edit OTHER admins/owners
  const isSelfEdit = String(targetUser.id) === String(req.user.id);
  if ((targetUser.role === 'ADMIN' || targetUser.role === 'OWNER') && !isSelfEdit) {
    return res.status(403).json({ success: false, message: 'Cannot modify other admin accounts' });
  }
  
  // If it's a non-admin trying to edit an admin (shouldn't happen, but just in case)
  if (adminUser.role !== 'ADMIN' && adminUser.role !== 'OWNER' && (targetUser.role === 'ADMIN' || targetUser.role === 'OWNER')) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }

  const updateData = {};
  if (name) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (is_active !== undefined) updateData.is_active = is_active;
  if (profile_photo !== undefined) updateData.profile_photo = profile_photo;
  if (team_id !== undefined) updateData.team_id = team_id || null;

  if (email) {
    const existing = await userModel.findByEmail(email, pool);
    if (existing && existing.id !== id) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    updateData.email = email;
  }

  if (password) {
    updateData.password = await hashPassword(password);
  }

  if (role && VALID_ROLES.includes(role)) {
    updateData.role = role;
  }

  if (sponsorRefCode) {
    const sponsor = await userModel.findBySponsorCode(String(sponsorRefCode).trim(), pool);
    if (!sponsor || sponsor.site_id !== adminUser.site_id) {
      return res.status(400).json({ success: false, message: 'Invalid sponsor code' });
    }
    updateData.sponsor_id = sponsor.id;
    updateData.parent_id = sponsor.id;
  }

  // Note: we can still trigger an update if there's only profile_data changing, so don't completely prevent if Object.keys(updateData) is empty yet
  let updated = targetUser;
  if (Object.keys(updateData).length > 0) {
    updated = await userModel.update(id, updateData, pool);
  }

  // Save extended profile data if provided during edit
  if (category_id && profile_data) {
    await userProfileModel.upsertByUserId(
      updated.id,
      adminUser.site_id,
      category_id,
      profile_data,
      pool
    );
  }

  bustCache('cache:*:/api/site/*');
  if (team_id !== undefined) bustCache('cache:*:/api/teams*');
  res.json({ success: true, user: sanitizeUser(updated) });
});

// Delete a user in admin's site
export const deleteSiteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const targetUser = await userModel.findById(id, pool);
  if (!targetUser || targetUser.site_id !== adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'User not found in your site' });
  }

  if (targetUser.role === 'ADMIN' || targetUser.role === 'OWNER') {
    return res.status(403).json({ success: false, message: 'Cannot delete this user' });
  }

  await userModel.delete(id, pool);
  bustCache('cache:*:/api/site/*');
  res.json({ success: true, message: 'User deleted successfully' });
});

// Get referral/downline tree for a user
export const getUserDownline = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const targetUser = await userModel.findById(id, pool);
  if (!targetUser || targetUser.site_id !== adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'User not found in your site' });
  }

  const downline = await userModel.getDownline(id, pool);
  const referrals = await userModel.getReferrals(id, pool);

  res.json({
    success: true,
    user: sanitizeUser(targetUser),
    downline,
    referrals,
  });
});

// Get team heads for dropdown
export const getTeamHeads = asyncHandler(async (req, res) => {
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const teamHeads = await userModel.findBySiteAndRole(adminUser.site_id, 'TEAM_HEAD', pool);
  res.json({ success: true, teamHeads });
});

// Get agents for dropdown
export const getAgents = asyncHandler(async (req, res) => {
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const agents = await userModel.findBySiteAndRole(adminUser.site_id, 'AGENT', pool);
  res.json({ success: true, agents });
});

// Search users by name or phone within admin's site
export const searchSiteUsers = asyncHandler(async (req, res) => {
  const { q, limit = 8 } = req.query;
  const term = String(q ?? '').trim();

  if (term.length < 2) {
    return res.json({ success: true, users: [] });
  }

  // Clamp limit between 1 and 20 to prevent abuse
  const limitVal = Math.min(Math.max(1, parseInt(limit, 10) || 8), 20);

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const likeTerm  = `%${term}%`;   // contains match
  const startTerm = `${term}%`;    // starts-with (for ranking)

  const result = await pool.query(
    `SELECT id, name, email, phone, role, profile_photo, sponsor_code, is_active, team_id, created_at
     FROM users
     WHERE site_id = $1
       AND role != 'ADMIN'
       AND (name ILIKE $2 OR phone ILIKE $2)
     ORDER BY
       CASE WHEN name ILIKE $3 THEN 0 ELSE 1 END,
       name
     LIMIT $4`,
    [adminUser.site_id, likeTerm, startTerm, limitVal]
  );

  res.json({ success: true, users: result.rows });
});

// Get leads for dropdowns (call module)
export const getLeads = asyncHandler(async (req, res) => {
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const query = `
    SELECT id, name, phone, email, status, assigned_to, created_at
    FROM leads
    WHERE site_id = $1
    ORDER BY created_at DESC
    LIMIT 200
  `;
  const result = await pool.query(query, [adminUser.site_id]);
  res.json({ success: true, leads: result.rows });
});

