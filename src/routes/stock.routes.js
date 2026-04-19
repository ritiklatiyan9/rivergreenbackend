import express from 'express';
import {
    createStockTransaction,
    getStockHistoryByProduct,
} from '../controllers/inventoryStock.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/transaction', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), createStockTransaction);
router.get('/history/:productId', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(60), getStockHistoryByProduct);

export default router;
