import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import {
  getModuleCatalog,
  listUsersWithSidebarPermissions,
  getUserSidebarPermissions,
  updateUserSidebarPermissions,
} from '../controllers/sidebarPermission.controller.js';

const router = express.Router();

// All admin-side sidebar permission routes require OWNER/ADMIN
router.use(authMiddleware, checkRole(['OWNER', 'ADMIN']));

router.get('/modules', getModuleCatalog);
router.get('/users', listUsersWithSidebarPermissions);
router.get('/users/:id', getUserSidebarPermissions);
router.put('/users/:id', updateUserSidebarPermissions);

export default router;
