import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import userCategoryModel from '../models/UserCategory.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// List all categories for admin's site
export const listCategories = asyncHandler(async (req, res) => {
    const adminUser = await userModel.findById(req.user.id, pool);
  if (adminUser && req.user?.site_id) adminUser.site_id = req.user.site_id;
    if (!adminUser || !adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const categories = await userCategoryModel.findBySite(adminUser.site_id, pool);
    res.json({ success: true, categories });
});

// List active categories (for registration dropdown)
export const listActiveCategories = asyncHandler(async (req, res) => {
    const adminUser = await userModel.findById(req.user.id, pool);
  if (adminUser && req.user?.site_id) adminUser.site_id = req.user.site_id;
    if (!adminUser || !adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const categories = await userCategoryModel.findActiveBySite(adminUser.site_id, pool);
    res.json({ success: true, categories });
});

// Create a new category
export const createCategory = asyncHandler(async (req, res) => {
    const { name, description, field_groups } = req.body;

    if (!name || !field_groups || !Array.isArray(field_groups) || field_groups.length === 0) {
        return res.status(400).json({ success: false, message: 'Name and at least one field group are required' });
    }

    const adminUser = await userModel.findById(req.user.id, pool);
  if (adminUser && req.user?.site_id) adminUser.site_id = req.user.site_id;
    if (!adminUser || !adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    // Use raw SQL to handle TEXT[] properly
    const query = `
    INSERT INTO user_categories (site_id, name, description, field_groups)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
    const result = await pool.query(query, [adminUser.site_id, name, description || null, field_groups]);
    bustCache('cache:*:/api/site/user-categories*');
    res.status(201).json({ success: true, category: result.rows[0] });
});

// Update a category
export const updateCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { name, description, field_groups, is_active } = req.body;

    const adminUser = await userModel.findById(req.user.id, pool);
  if (adminUser && req.user?.site_id) adminUser.site_id = req.user.site_id;
    if (!adminUser || !adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const category = await userCategoryModel.findById(id, pool);
    if (!category || category.site_id !== adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }

    // Build update with raw SQL for TEXT[] handling
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (field_groups !== undefined) { updates.push(`field_groups = $${idx++}`); values.push(field_groups); }
    if (is_active !== undefined) { updates.push(`is_active = $${idx++}`); values.push(is_active); }

    if (updates.length === 0) {
        return res.status(400).json({ success: false, message: 'No data to update' });
    }

    values.push(id);
    const query = `UPDATE user_categories SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(query, values);
    bustCache('cache:*:/api/site/user-categories*');
    res.json({ success: true, category: result.rows[0] });
});

// Delete a category
export const deleteCategory = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const adminUser = await userModel.findById(req.user.id, pool);
  if (adminUser && req.user?.site_id) adminUser.site_id = req.user.site_id;
    if (!adminUser || !adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'No site assigned' });
    }

    const category = await userCategoryModel.findById(id, pool);
    if (!category || category.site_id !== adminUser.site_id) {
        return res.status(404).json({ success: false, message: 'Category not found' });
    }

    await userCategoryModel.delete(id, pool);
    bustCache('cache:*:/api/site/user-categories*');
    res.json({ success: true, message: 'Category deleted successfully' });
});
