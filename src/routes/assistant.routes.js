import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import assistantRateLimit from '../middlewares/assistantRateLimit.middleware.js';
import { chatWithSalesAssistant, chatWithSalesAssistantStream } from '../controllers/assistant.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.post('/chat', assistantRateLimit, chatWithSalesAssistant);
router.post('/chat/stream', assistantRateLimit, chatWithSalesAssistantStream);

export default router;
