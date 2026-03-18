import express from 'express';
const router = express.Router();

import {
  createAdmin, listAdmins, updateAdmin, deleteAdmin, getAdminCount,
  createSite, listSites, updateSite, deleteSite, getSiteCount, getOwnerStats,
  getAllUsersForAccess, updateUserAccountAccess, updateUserSiteAccess,
  resetUserPassword, changeOwnPassword,
} from '../controllers/admin.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// Admin panel routes require authentication + OWNER/ADMIN role
router.use(authMiddleware, checkRole(['OWNER', 'ADMIN']));

// Owner dashboard
router.get('/stats', cacheMiddleware(300), getOwnerStats);

// User access management (must come before generic /:id routes)
router.get('/users/access', cacheMiddleware(300), getAllUsersForAccess);
router.put('/users/:id/account-access', updateUserAccountAccess);
router.put('/users/:id/site-access', updateUserSiteAccess);
router.put('/users/:id/reset-password', resetUserPassword);
router.put('/auth/change-password', changeOwnPassword);

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
