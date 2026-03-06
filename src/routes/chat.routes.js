import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';
import chatUpload from '../middlewares/chatUpload.middleware.js';
import {
  getConversations,
  startConversation,
  getMessages,
  sendMessage,
  sendFileMessage,
  editMessage,
  deleteMessage,
  getChatUsers,
  getPermissions,
  updatePermission,
  getMyPermissions,
} from '../controllers/chat.controller.js';

const router = express.Router();

// All chat routes require authentication
router.use(authMiddleware);

// Chat users
router.get('/users', getChatUsers);

// User's own permissions
router.get('/my-permissions', getMyPermissions);

// Conversations
router.get('/conversations', getConversations);
router.post('/conversations', startConversation);

// Messages
router.get('/conversations/:id/messages', getMessages);
router.post('/conversations/:id/messages', sendMessage);
router.post('/conversations/:id/upload', chatUpload.single('file'), sendFileMessage);

// Message actions
router.put('/messages/:id', editMessage);
router.delete('/messages/:id', deleteMessage);

// Admin-only: permissions management
router.get('/permissions', checkRole(['ADMIN']), getPermissions);
router.put('/permissions/:roleName', checkRole(['ADMIN']), updatePermission);

export default router;
