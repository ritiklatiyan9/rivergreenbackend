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
    getLeadsForDialer,
    getShiftToCallQueue,
    quickLogCall,
    endCallSession,
    getAgentCallDetails,
    getAdvancedAnalytics,
} from '../controllers/call.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All call routes require authentication
router.use(authMiddleware);

// Call outcomes (all authenticated users can fetch) — rarely changes
router.get('/outcomes', cacheMiddleware(600), getCallOutcomes);

// Leads Dialer — live list of leads; short TTL
router.get('/leads-dialer', cacheMiddleware(60), getLeadsForDialer);
router.get('/shift-to-call', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(15), getShiftToCallQueue);

// Analytics
router.get('/analytics', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getCallAnalytics);

// Advanced Analytics (Admin/Owner only)
router.get('/advanced-analytics', checkRole(['ADMIN', 'OWNER']), cacheMiddleware(120), getAdvancedAnalytics);

// Agent call details
router.get('/agent/:agent_id/details', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(120), getAgentCallDetails);

// Follow-up compliance
router.get('/compliance', cacheMiddleware(120), getFollowupCompliance);

// Calls by lead (timeline)
router.get('/lead/:leadId', cacheMiddleware(60), getCallsByLead);

// Quick log — agent clicks call icon
router.post('/quick-log', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), quickLogCall);

// End call session
router.put('/:id/end', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), endCallSession);

// Bulk create (Daily Entry)
router.post('/bulk', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), bulkLogCalls);

// Call CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), logCall);
router.get('/', cacheMiddleware(60), getCalls);
router.get('/:id', cacheMiddleware(120), getCall);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), updateCall);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteCall);

export default router;
