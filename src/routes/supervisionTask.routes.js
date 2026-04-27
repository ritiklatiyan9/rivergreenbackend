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

const ASSIGNEE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'AGENT', 'TEAM_HEAD'];

// Admin/Owner only — create, delete, fetch assignment list
router.post('/', checkRole(['ADMIN', 'OWNER']), createSupervisionTask);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteSupervisionTask);
router.get('/supervisors', checkRole(['ADMIN', 'OWNER']), getSupervisorsForAssignment);

// Admin + every possible assignee role can read & update their own task
router.get('/', checkRole(ASSIGNEE_ROLES), cacheMiddleware(60), getSupervisionTasks);
router.get('/analytics', checkRole(ASSIGNEE_ROLES), cacheMiddleware(60), getSupervisionAnalytics);
router.get('/:id', checkRole(ASSIGNEE_ROLES), getSupervisionTask);
router.put('/:id', checkRole(ASSIGNEE_ROLES), updateSupervisionTask);

export default router;
