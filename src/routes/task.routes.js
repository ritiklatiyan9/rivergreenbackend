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

// Stats & list
router.get('/stats', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getTaskStats);
router.get('/', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(60), getTasks);

// Auto-shift overdue tasks
router.post('/auto-shift', checkRole(['ADMIN', 'OWNER']), autoShiftOverdue);

// CRUD
router.post('/', checkRole(['ADMIN', 'OWNER']), createTask);
router.put('/:id', checkRole(['ADMIN', 'OWNER']), updateTask);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteTask);

// Date shift & history
router.post('/:id/shift', checkRole(['ADMIN', 'OWNER']), shiftTaskDueDate);
router.get('/:id/shifts', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(120), getTaskShiftHistory);

export default router;
