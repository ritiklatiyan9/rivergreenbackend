import express from 'express';
const router = express.Router();

import {
    createFollowup,
    getFollowups,
    getScheduledFollowups,
    getMissedFollowups,
    getFollowupCounts,
    getReminders,
    updateFollowup,
    snoozeFollowup,
    escalateFollowup,
} from '../controllers/followup.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All followup routes require authentication
router.use(authMiddleware);

// Dashboard counts
router.get('/counts', cacheMiddleware(60), getFollowupCounts);

// Reminders — unified view
router.get('/reminders', cacheMiddleware(45), getReminders);

// Scheduled & Missed
router.get('/scheduled', cacheMiddleware(60), getScheduledFollowups);
router.get('/missed', cacheMiddleware(60), getMissedFollowups);

// CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), createFollowup);
router.get('/', cacheMiddleware(60), getFollowups);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), updateFollowup);

// Snooze & Escalate
router.put('/:id/snooze', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), snoozeFollowup);
router.put('/:id/escalate', checkRole(['TEAM_HEAD', 'ADMIN']), escalateFollowup);

export default router;
