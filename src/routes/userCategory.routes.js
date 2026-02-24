import express from 'express';
const router = express.Router();

import {
    listCategories,
    listActiveCategories,
    createCategory,
    updateCategory,
    deleteCategory,
} from '../controllers/userCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All routes require authentication + ADMIN role
router.use(authMiddleware, checkRole(['ADMIN']));

router.get('/', cacheMiddleware(600), listCategories);
router.get('/active', cacheMiddleware(600), listActiveCategories);
router.post('/', createCategory);
router.put('/:id', updateCategory);
router.delete('/:id', deleteCategory);

export default router;
