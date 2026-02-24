import express from 'express';
const router = express.Router();

import {
  createTeam,
  listTeams,
  getTeam,
  updateTeam,
  deleteTeam,
  assignTeamHead,
  moveAgent,
  getTeamPerformance,
  setTeamTarget,
  getTeamTargets,
} from '../controllers/team.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All team routes require authentication + ADMIN role
router.use(authMiddleware, checkRole(['ADMIN']));

// Assign head & move agent
router.put('/move-agent', moveAgent);

// Team CRUD
router.post('/', createTeam);
router.get('/', cacheMiddleware(300), listTeams);
router.get('/:id', cacheMiddleware(300), getTeam);
router.put('/:id', updateTeam);
router.delete('/:id', deleteTeam);

// Assign head
router.put('/:id/assign-head', assignTeamHead);

// Performance
router.get('/:id/performance', cacheMiddleware(300), getTeamPerformance);

// Targets
router.post('/:id/targets', setTeamTarget);
router.get('/:id/targets', cacheMiddleware(300), getTeamTargets);

export default router;
