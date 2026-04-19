import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import inventoryCategoryService from '../services/inventoryCategory.service.js';

const getSiteId = async (userId, reqUser) => {
    if (reqUser?.site_id) return reqUser.site_id;
    const user = await userModel.findById(userId, pool);
    return user?.site_id || null;
};

const bustInventoryCategoryCache = () => {
    bustCache('cache:*:/api/categories*');
    bustCache('cache:*:/api/products*');
};

export const getCategories = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const result = await inventoryCategoryService.getCategories(siteId, req.query, pool);
    res.json({
        success: true,
        categories: result.items,
        pagination: result.pagination,
    });
});

export const createCategory = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const category = await inventoryCategoryService.createCategory(siteId, req.body, pool);
    bustInventoryCategoryCache();
    res.status(201).json({ success: true, category });
});

export const updateCategory = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const category = await inventoryCategoryService.updateCategory(siteId, req.params.id, req.body, pool);
    bustInventoryCategoryCache();
    res.json({ success: true, category });
});

export const deleteCategory = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    await inventoryCategoryService.deleteCategory(siteId, req.params.id, pool);
    bustInventoryCategoryCache();
    res.json({ success: true, message: 'Category deleted successfully' });
});
