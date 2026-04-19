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
// SUPERVISOR MANAGEMENT (OWNER / ADMIN)
// ============================================================

// Create Supervisor
export const createSupervisor = asyncHandler(async (req, res) => {
  const { name, email, password, phone, site_ids } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Name, email and password are required' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ success: false, message: 'Email already exists' });

  const sponsorCode = await userModel.getUniqueSponsorCode(pool);
  const hashedPassword = await hashPassword(password);

  // Use first assigned site as primary site_id, or null
  const primarySiteId = Array.isArray(site_ids) && site_ids.length > 0 ? site_ids[0] : null;

  const userData = {
    name,
    email,
    phone: phone || null,
    password: hashedPassword,
    role: 'SUPERVISOR',
    site_id: primarySiteId,
    sponsor_code: sponsorCode,
    sponsor_id: null,
    parent_id: null,
    token_version: 1,
  };

  const supervisor = await userModel.create(userData, pool);

  // Assign sites if provided
  if (Array.isArray(site_ids) && site_ids.length > 0) {
    for (const siteId of site_ids) {
      await pool.query(
        `INSERT INTO supervisor_site_access (supervisor_id, site_id) VALUES ($1, $2) ON CONFLICT (supervisor_id, site_id) DO NOTHING`,
        [supervisor.id, siteId],
      );
    }
  }

  bustCache('cache:*:/api/supervisors*');
  bustCache('cache:*:/api/admin/*');
  res.status(201).json({ success: true, supervisor: sanitizeUser(supervisor) });
});

// List all Supervisors (with assigned sites)
export const listSupervisors = asyncHandler(async (req, res) => {
  const query = `
    SELECT 
      u.id, u.name, u.email, u.phone, u.role, u.site_id, u.is_active, u.created_at, u.updated_at,
      s.name as primary_site_name,
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT('id', assigned_s.id, 'name', assigned_s.name)
        ) FILTER (WHERE assigned_s.id IS NOT NULL),
        '[]'::json
      ) AS assigned_sites,
      COALESCE(
        ARRAY_AGG(DISTINCT ssa.site_id) FILTER (WHERE ssa.site_id IS NOT NULL),
        ARRAY[]::uuid[]
      ) AS assigned_site_ids
    FROM users u
    LEFT JOIN sites s ON u.site_id = s.id
    LEFT JOIN supervisor_site_access ssa ON ssa.supervisor_id = u.id
    LEFT JOIN sites assigned_s ON ssa.site_id = assigned_s.id
    WHERE u.role = 'SUPERVISOR'
    GROUP BY u.id, s.name
    ORDER BY u.created_at DESC
  `;

  const result = await pool.query(query);
  res.json({ success: true, supervisors: result.rows.map(sanitizeUser) });
});

// Get single supervisor with details
export const getSupervisor = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT 
      u.id, u.name, u.email, u.phone, u.role, u.site_id, u.is_active, u.created_at, u.updated_at,
      s.name as primary_site_name,
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT('id', assigned_s.id, 'name', assigned_s.name)
        ) FILTER (WHERE assigned_s.id IS NOT NULL),
        '[]'::json
      ) AS assigned_sites,
      COALESCE(
        ARRAY_AGG(DISTINCT ssa.site_id) FILTER (WHERE ssa.site_id IS NOT NULL),
        ARRAY[]::uuid[]
      ) AS assigned_site_ids
    FROM users u
    LEFT JOIN sites s ON u.site_id = s.id
    LEFT JOIN supervisor_site_access ssa ON ssa.supervisor_id = u.id
    LEFT JOIN sites assigned_s ON ssa.site_id = assigned_s.id
    WHERE u.id = $1 AND u.role = 'SUPERVISOR'
    GROUP BY u.id, s.name
  `;

  const result = await pool.query(query, [id]);
  if (!result.rows[0]) {
    return res.status(404).json({ success: false, message: 'Supervisor not found' });
  }

  res.json({ success: true, supervisor: sanitizeUser(result.rows[0]) });
});

// Update Supervisor
export const updateSupervisor = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, password, phone, is_active, site_ids } = req.body;

  const supervisor = await userModel.findById(id, pool);
  if (!supervisor || supervisor.role !== 'SUPERVISOR') {
    return res.status(404).json({ success: false, message: 'Supervisor not found' });
  }

  const updateData = {};
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

  if (password) {
    updateData.password = await hashPassword(password);
  }

  // Update assigned sites
  if (Array.isArray(site_ids)) {
    // Clear existing and re-insert
    await pool.query('DELETE FROM supervisor_site_access WHERE supervisor_id = $1', [id]);
    for (const siteId of site_ids) {
      await pool.query(
        `INSERT INTO supervisor_site_access (supervisor_id, site_id) VALUES ($1, $2) ON CONFLICT (supervisor_id, site_id) DO NOTHING`,
        [id, siteId],
      );
    }
    // Update primary site_id
    updateData.site_id = site_ids.length > 0 ? site_ids[0] : null;
  }

  if (Object.keys(updateData).length === 0 && !Array.isArray(site_ids)) {
    return res.status(400).json({ success: false, message: 'No data to update' });
  }

  if (Object.keys(updateData).length > 0) {
    await userModel.update(id, updateData, pool);
  }

  // Fetch updated supervisor with sites
  const updated = await pool.query(`
    SELECT 
      u.id, u.name, u.email, u.phone, u.role, u.site_id, u.is_active, u.created_at, u.updated_at,
      s.name as primary_site_name,
      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT('id', assigned_s.id, 'name', assigned_s.name)
        ) FILTER (WHERE assigned_s.id IS NOT NULL),
        '[]'::json
      ) AS assigned_sites,
      COALESCE(
        ARRAY_AGG(DISTINCT ssa.site_id) FILTER (WHERE ssa.site_id IS NOT NULL),
        ARRAY[]::uuid[]
      ) AS assigned_site_ids
    FROM users u
    LEFT JOIN sites s ON u.site_id = s.id
    LEFT JOIN supervisor_site_access ssa ON ssa.supervisor_id = u.id
    LEFT JOIN sites assigned_s ON ssa.site_id = assigned_s.id
    WHERE u.id = $1
    GROUP BY u.id, s.name
  `, [id]);

  bustCache('cache:*:/api/supervisors*');
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, supervisor: sanitizeUser(updated.rows[0]) });
});

// Delete Supervisor
export const deleteSupervisor = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const supervisor = await userModel.findById(id, pool);
  if (!supervisor || supervisor.role !== 'SUPERVISOR') {
    return res.status(404).json({ success: false, message: 'Supervisor not found' });
  }

  // Delete site access entries first (cascade should handle it, but be explicit)
  await pool.query('DELETE FROM supervisor_site_access WHERE supervisor_id = $1', [id]);
  await userModel.delete(id, pool);

  bustCache('cache:*:/api/supervisors*');
  bustCache('cache:*:/api/admin/*');
  res.json({ success: true, message: 'Supervisor deleted successfully' });
});

// Get supervisor count
export const getSupervisorCount = asyncHandler(async (req, res) => {
  const count = await userModel.countByRole('SUPERVISOR', pool);
  res.json({ success: true, count });
});
