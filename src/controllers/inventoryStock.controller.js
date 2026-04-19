import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import inventoryStockService from '../services/inventoryStock.service.js';

const getSiteId = async (userId, reqUser) => {
    if (reqUser?.site_id) return reqUser.site_id;
    const user = await userModel.findById(userId, pool);
    return user?.site_id || null;
};

const bustInventoryStockCache = () => {
    bustCache('cache:*:/api/stocks*');
    bustCache('cache:*:/api/products*');
};

export const createStockTransaction = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const result = await inventoryStockService.createTransaction(siteId, req.user.id, req.body, pool);
    bustInventoryStockCache();

    res.status(201).json({
        success: true,
        transaction: result.transaction,
        product: result.product,
    });
});

export const getStockHistoryByProduct = asyncHandler(async (req, res) => {
    const siteId = await getSiteId(req.user.id, req.user);
    if (!siteId) {
        return res.status(404).json({ success: false, message: 'No active site selected. Please choose a site and try again.' });
    }

    const result = await inventoryStockService.getHistory(siteId, req.params.productId, req.query, pool);
    res.json({
        success: true,
        product: result.product,
        history: result.items,
        pagination: result.pagination,
    });
});
