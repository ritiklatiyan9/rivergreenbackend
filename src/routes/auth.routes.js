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
	registerFcmToken,
	removeFcmToken,
	sendTestPush,
} from '../controllers/auth.controller.js';
import { getMySidebarModules } from '../controllers/sidebarPermission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { rateLimit } from '../middlewares/rateLimit.middleware.js';

const authIdentity = (req) => `${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`;
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  keyPrefix: 'login',
  keyGenerator: authIdentity,
});
const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  keyPrefix: 'refresh',
});
const ownerRegistrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyPrefix: 'owner-registration',
});

router.post('/register-owner', ownerRegistrationLimiter, registerOwner);
router.post('/login', loginLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);
router.get('/sidebar-modules', authMiddleware, getMySidebarModules);
router.get('/sites', authMiddleware, getAccessibleSites);
router.put('/active-site', authMiddleware, setActiveSite);
router.put('/profile', authMiddleware, upload.single('profile_photo'), updateProfile);

// Push notifications — device token lifecycle
router.post('/fcm-token', authMiddleware, registerFcmToken);
router.delete('/fcm-token', authMiddleware, removeFcmToken);
router.post('/fcm-test', authMiddleware, sendTestPush);

export default router;
