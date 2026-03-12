import express from 'express';
const router = express.Router();

import {
  getMySite,
  getSiteStats,
  listSiteUsers,
  searchSiteUsers,
  createSiteUser,
  getSiteUser,
  updateSiteUser,
  deleteSiteUser,
  getUserDownline,
  getTeamHeads,
  getAgents,
  getLeads,
} from '../controllers/site.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All site routes require authentication + ADMIN role
router.use(authMiddleware, checkRole(['ADMIN']));

// Site info
router.get('/my-site', cacheMiddleware(300), getMySite);
router.get('/stats', cacheMiddleware(300), getSiteStats);

// User management within site
router.get('/users', cacheMiddleware(300), listSiteUsers);
router.get('/users/search', searchSiteUsers);        // must be before /:id
router.post('/users', createSiteUser);
router.get('/users/:id', cacheMiddleware(300), getSiteUser);
router.put('/users/:id', updateSiteUser);
router.delete('/users/:id', deleteSiteUser);

// Hierarchy
router.get('/users/:id/downline', cacheMiddleware(300), getUserDownline);

// Dropdowns
router.get('/team-heads', cacheMiddleware(300), getTeamHeads);
router.get('/agents', cacheMiddleware(300), getAgents);
router.get('/leads', cacheMiddleware(60), getLeads);

export default router;
