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
  removeTeamMember,
  getTeamPerformance,
  setTeamTarget,
  getTeamTargets,
} from '../controllers/team.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All team routes require authentication
router.use(authMiddleware);

// Read-only access for agents & team heads (own team)
router.get('/:id', checkRole(['AGENT', 'TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(300), getTeam);
router.get('/:id/performance', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(300), getTeamPerformance);
router.get('/:id/targets', checkRole(['TEAM_HEAD', 'ADMIN', 'OWNER']), cacheMiddleware(300), getTeamTargets);

// Admin-only routes below
router.use(checkRole(['ADMIN']));

// Assign head & move agent
router.put('/move-agent', moveAgent);

// Team CRUD
router.post('/', createTeam);
router.get('/', cacheMiddleware(300), listTeams);
router.put('/:id', updateTeam);
router.delete('/:id', deleteTeam);

// Assign head
router.put('/:id/assign-head', assignTeamHead);

// Members
router.delete('/:id/members/:userId', removeTeamMember);

// Targets
router.post('/:id/targets', setTeamTarget);

export default router;
