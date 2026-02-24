import express from 'express';
const router = express.Router();

import {
    createFollowup,
    getFollowups,
    getScheduledFollowups,
    getMissedFollowups,
    getFollowupCounts,
    updateFollowup,
    snoozeFollowup,
    escalateFollowup,
} from '../controllers/followup.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';

// All followup routes require authentication
router.use(authMiddleware);

// Dashboard counts
router.get('/counts', getFollowupCounts);

// Scheduled & Missed
router.get('/scheduled', getScheduledFollowups);
router.get('/missed', getMissedFollowups);

// CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), createFollowup);
router.get('/', getFollowups);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), updateFollowup);

// Snooze & Escalate
router.put('/:id/snooze', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), snoozeFollowup);
router.put('/:id/escalate', checkRole(['TEAM_HEAD', 'ADMIN']), escalateFollowup);

export default router;
