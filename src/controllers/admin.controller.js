import asyncHandler from '../utils/asyncHandler.js';
import { hashPassword } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

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
  const sites = await siteModel.findWithAdminCount(req.user.id, pool);
  res.json({ success: true, sites });
});

// Update site
export const updateSite = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, address, city, state, description, is_active } = req.body;

  const site = await siteModel.findById(id, pool);
  if (!site || site.created_by !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Site not found' });
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
  if (!site || site.created_by !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Site not found' });
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
  if (!name || !email || !password || !site_id) {
    return res.status(400).json({ success: false, message: 'Name, email, password and site_id are required' });
  }

  // Verify site belongs to this owner
  const site = await siteModel.findById(site_id, pool);
  if (!site || site.created_by !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Site not found' });
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
    site_id,
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
  const admins = await userModel.findAllByRole('ADMIN', pool);

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
    if (!site || site.created_by !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Site not found' });
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
