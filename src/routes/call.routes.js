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

// Call outcomes (all authenticated users can fetch)
router.get('/outcomes', getCallOutcomes);

// Leads Dialer — all leads with phone + call icon
router.get('/leads-dialer', getLeadsForDialer);

// Analytics (Team Heads, Admins, Owners only)
router.get('/analytics', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), getCallAnalytics);

// Advanced Analytics (Admin/Owner only)
router.get('/advanced-analytics', checkRole(['ADMIN', 'OWNER']), getAdvancedAnalytics);

// Agent call details
router.get('/agent/:agent_id/details', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), getAgentCallDetails);

// Follow-up compliance
router.get('/compliance', getFollowupCompliance);

// Calls by lead (timeline)
router.get('/lead/:leadId', getCallsByLead);

// Quick log — agent clicks call icon
router.post('/quick-log', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), quickLogCall);

// End call session
router.put('/:id/end', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), endCallSession);

// Bulk create (Daily Entry)
router.post('/bulk', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), bulkLogCalls);

// Call CRUD
router.post('/', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), logCall);
router.get('/', getCalls);
router.get('/:id', getCall);
router.put('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN']), updateCall);
router.delete('/:id', checkRole(['ADMIN', 'OWNER']), deleteCall);

export default router;
