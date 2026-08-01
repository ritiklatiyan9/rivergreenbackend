import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import assistantRateLimit from '../middlewares/assistantRateLimit.middleware.js';
import { chatWithSalesAssistant } from '../controllers/assistant.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.post('/chat', assistantRateLimit, chatWithSalesAssistant);

export default router;
