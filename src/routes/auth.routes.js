import express from 'express';
const router = express.Router();

import { registerOwner, login, refresh, logout, getMe, updateProfile } from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';

router.post('/register-owner', registerOwner);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.put('/profile', authMiddleware, updateProfile);

export default router;