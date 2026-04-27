import express from 'express';
const router = express.Router();

import {
    getTasks,
    getTaskStats,
    createTask,
    updateTask,
    deleteTask,
    shiftTaskDueDate,
    getTaskShiftHistory,
    autoShiftOverdue,
} from '../controllers/task.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

router.use(authMiddleware);

const ALLOWED_ROLES = ['ADMIN', 'OWNER', 'TEAM_HEAD', 'AGENT', 'SUPERVISOR'];

// Stats & list
router.get('/stats', checkRole(ALLOWED_ROLES), cacheMiddleware(60), getTaskStats);
router.get('/', checkRole(ALLOWED_ROLES), cacheMiddleware(60), getTasks);

// Auto-shift overdue tasks
router.post('/auto-shift', checkRole(ALLOWED_ROLES), autoShiftOverdue);

// CRUD
router.post('/', checkRole(ALLOWED_ROLES), createTask);
router.put('/:id', checkRole(ALLOWED_ROLES), updateTask);
router.delete('/:id', checkRole(ALLOWED_ROLES), deleteTask);

// Date shift & history
router.post('/:id/shift', checkRole(ALLOWED_ROLES), shiftTaskDueDate);
router.get('/:id/shifts', checkRole(ALLOWED_ROLES), cacheMiddleware(120), getTaskShiftHistory);

export default router;
