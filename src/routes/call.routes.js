import express from 'express';
const router = express.Router();

import {
    logCall,
    getCalls,
    getCall,
    updateCall,
    deleteCall,
    getCallsByLead,
    getCallAnalytics,
    getCallOutcomes,
    bulkLogCalls,
    getFollowupCompliance,
} from '../controllers/call.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All call routes require authentication
router.use(authMiddleware);

// Call outcomes (all authenticated users can fetch)
router.get('/outcomes', getCallOutcomes);

// Analytics (Team Heads, Admins, Owners only)
router.get('/analytics', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), getCallAnalytics);

// Follow-up compliance
router.get('/compliance', getFollowupCompliance);

// Calls by lead (timeline)
router.get('/lead/:leadId', getCallsByLead);

// Bulk create (Daily Entry)
router.post('/bulk', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), bulkLogCalls);

// Call CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), logCall);
router.get('/', getCalls);
router.get('/:id', getCall);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), updateCall);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteCall);

export default router;
