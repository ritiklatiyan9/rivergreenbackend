import express from 'express';
const router = express.Router();

import {
  createSupervisor,
  listSupervisors,
  getSupervisor,
  updateSupervisor,
  deleteSupervisor,
  getSupervisorCount,
} from '../controllers/supervisor.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

// Only OWNER and ADMIN can manage supervisors
router.use(authMiddleware, checkRole(['OWNER', 'ADMIN']));

router.post('/', createSupervisor);
router.get('/', cacheMiddleware(300), listSupervisors);
router.get('/count', cacheMiddleware(300), getSupervisorCount);
router.get('/:id', getSupervisor);
router.put('/:id', updateSupervisor);
router.delete('/:id', deleteSupervisor);

export default router;
