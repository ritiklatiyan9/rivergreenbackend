import express from 'express';
import {
  createSupervisionTask,
  getSupervisionTasks,
  getSupervisionTask,
  updateSupervisionTask,
  deleteSupervisionTask,
  getSupervisionAnalytics,
  getSupervisorsForAssignment,
} from '../controllers/supervisionTask.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);

// Admin/Owner only
router.post('/', checkRole(['ADMIN', 'OWNER']), createSupervisionTask);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteSupervisionTask);
router.get('/supervisors', checkRole(['ADMIN', 'OWNER']), getSupervisorsForAssignment);

// Both Admin and Supervisor
router.get('/', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(60), getSupervisionTasks);
router.get('/analytics', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), cacheMiddleware(60), getSupervisionAnalytics);
router.get('/:id', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), getSupervisionTask);
router.put('/:id', checkRole(['ADMIN', 'OWNER', 'SUPERVISOR']), updateSupervisionTask);

export default router;
