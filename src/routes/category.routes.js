import express from 'express';
import {
    createCategory,
    deleteCategory,
    getCategories,
    updateCategory,
} from '../controllers/inventoryCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(120), getCategories);
router.post('/', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), createCategory);
router.put('/:id', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), updateCategory);
router.delete('/:id', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), deleteCategory);

export default router;
