import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import inventoryProductService from '../services/inventoryProduct.service.js';

const getSiteId = async (userId, reqUser) => {
    if (reqUser?.site_id) return reqUser.site_id;
    const user = await userModel.findById(userId, pool);
    return user?.site_id || null;
};

const bustInventoryProductCache = () => {
    bustCache('cache:*:/api/products*');
    bustCache('cache:*:/api/stocks*');
};

export const getProducts = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const result = await inventoryProductService.getProducts(siteId, req.query, pool);
    res.json({
        success: true,
        products: result.items,
        pagination: result.pagination,
    });
});

export const getProductById = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const product = await inventoryProductService.getProductById(siteId, req.params.id, pool);
    res.json({ success: true, product });
});

export const createProduct = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const product = await inventoryProductService.createProduct(siteId, req.body, pool);
    bustInventoryProductCache();
    res.status(201).json({ success: true, product });
});
