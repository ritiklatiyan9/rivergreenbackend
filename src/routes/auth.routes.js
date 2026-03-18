import express from 'express';
const router = express.Router();

import {
	registerOwner,
	login,
	refresh,
	logout,
	getMe,
	updateProfile,
	getAccessibleSites,
	setActiveSite,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';

router.post('/register-owner', registerOwner);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.get('/sites', authMiddleware, getAccessibleSites);
router.put('/active-site', authMiddleware, setActiveSite);
router.put('/profile', authMiddleware, upload.single('profile_photo'), updateProfile);

export default router;