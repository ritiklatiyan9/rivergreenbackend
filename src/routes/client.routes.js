import express from 'express';
import { getClients, getClient, updateClient } from '../controllers/client.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

const router = express.Router();

router.use(authMiddleware);

router.get('/', getClients);
router.get('/:id', getClient);
router.put('/:id', updateClient);

export default router;
