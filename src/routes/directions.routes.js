import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import { getDirectionsRoute } from '../controllers/directions.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.get('/route', checkRole(['ADMIN', 'OWNER']), getDirectionsRoute);

export default router;
