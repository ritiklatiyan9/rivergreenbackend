import express from 'express';
const router = express.Router();

import {
  createAdmin, listAdmins, updateAdmin, deleteAdmin, getAdminCount,
  createSite, listSites, updateSite, deleteSite, getSiteCount, getOwnerStats,
} from '../controllers/admin.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All admin routes require authentication + OWNER role
router.use(authMiddleware, checkRole(['OWNER']));

// Owner dashboard
router.get('/stats', cacheMiddleware(300), getOwnerStats);

// Site management
router.post('/sites', createSite);
router.get('/sites', cacheMiddleware(300), listSites);
router.get('/sites/count', cacheMiddleware(300), getSiteCount);
router.put('/sites/:id', updateSite);
router.delete('/sites/:id', deleteSite);

// Admin (site admin) management
router.post('/', createAdmin);
router.get('/', cacheMiddleware(300), listAdmins);
router.get('/count', cacheMiddleware(300), getAdminCount);
router.put('/:id', updateAdmin);
router.delete('/:id', deleteAdmin);

export default router;
