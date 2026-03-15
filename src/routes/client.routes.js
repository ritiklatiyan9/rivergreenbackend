import express from 'express';
import { getClients, getClient, updateClient } from '../controllers/client.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { cacheMiddleware } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', cacheMiddleware(300), getClients);
router.get('/:id', cacheMiddleware(300), getClient);
router.put('/:id', updateClient);

export default router;
