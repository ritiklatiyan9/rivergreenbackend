import express from 'express';
import {
    createProduct,
    getProductById,
    getProducts,
} from '../controllers/inventoryProduct.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), createProduct);
router.get('/', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(120), getProducts);
router.get('/:id', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(120), getProductById);

export default router;
