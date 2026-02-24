import express from 'express';
const router = express.Router();

import {
  createActivity,
  getActivities,
  getActivity,
  updateActivity,
  deleteActivity,
  getTodayActivities,
  getActivityStats,
} from '../controllers/clientActivity.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';

// All activity routes require auth
router.use(authMiddleware);

// Stats
router.get('/stats', getActivityStats);

// Today's activities
router.get('/today', getTodayActivities);

// CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), createActivity);
router.get('/', getActivities);
router.get('/:id', getActivity);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), updateActivity);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteActivity);

export default router;
