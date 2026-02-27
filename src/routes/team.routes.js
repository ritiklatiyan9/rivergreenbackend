import express from 'express';
const router = express.Router();

import {
  createTeam,
  listTeams,
  getTeam,
  updateTeam,
  deleteTeam,
  assignTeamHead,
  removeTeamHead,
  moveAgent,
  removeTeamMember,
  getTeamPerformance,
  getTeamMembersPerformance,
  getAllTeamsPerformance,
  setTeamTarget,
  getTeamTargets,
} from '../controllers/team.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// All team routes require authentication
router.use(authMiddleware);

// Static paths MUST come before :id params
router.get('/all/performance', authMiddleware, checkRole(['ADMIN']), cacheMiddleware(120), getAllTeamsPerformance);

// Read-only access for agents & team heads (own team)
router.get('/:id', authMiddleware, cacheMiddleware(300), getTeam);
router.get('/:id/performance', authMiddleware, cacheMiddleware(300), getTeamPerformance);
router.get('/:id/members-performance', authMiddleware, cacheMiddleware(120), getTeamMembersPerformance);
router.get('/:id/targets', authMiddleware, cacheMiddleware(300), getTeamTargets);

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

// Remove head
router.delete('/:id/remove-head', removeTeamHead);

// Members
router.delete('/:id/members/:userId', removeTeamMember);

// Targets
router.post('/:id/targets', setTeamTarget);

export default router;
