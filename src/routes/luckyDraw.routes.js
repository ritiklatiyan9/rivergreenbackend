// Lucky Draw routes
//   /api/ld-auth/*  → public + LD-token-protected auth endpoints
//   /api/ld/*       → LD-token-protected module endpoints (managers/agents)
//   /api/admin/lucky-draw/*  → main-admin-token-protected endpoints

import express from 'express';
import {
  ldLogin, ldRefresh, ldMe, ldLogout,
  createLdUser, listLdUsers, updateLdUserPermissions, toggleLdUserBlock, resetLdUserPassword,
  createEvent, listEvents, getEvent, updateEventStatus, deleteEvent,
  createEntry, listMyEntries, listEntriesForEvent, updateEntry, deleteEntry,
  getReceipt, ldDashboardStats, listActivityLogs,
} from '../controllers/luckyDraw.controller.js';
import { ldAuth, requireManager, requireLdRole } from '../middlewares/ldAuth.middleware.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import checkRole from '../middlewares/role.middleware.js';

// ===== LD AUTH (separate login surface) =====
export const ldAuthRouter = express.Router();
ldAuthRouter.post('/login', ldLogin);
ldAuthRouter.post('/refresh', ldRefresh);
ldAuthRouter.post('/logout', ldAuth, ldLogout);
ldAuthRouter.get('/me', ldAuth, ldMe);

// ===== LD MODULE (managers + agents) =====
export const ldRouter = express.Router();
ldRouter.use(ldAuth);

// Dashboard
ldRouter.get('/dashboard/stats', ldDashboardStats);

// Events (read-only for LD users; admin creates/edits)
ldRouter.get('/events', listEvents);
ldRouter.get('/events/:id', getEvent);

// Entries
ldRouter.post('/entries', createEntry);
ldRouter.get('/entries/my', listMyEntries);
ldRouter.get('/entries/event/:id', listEntriesForEvent);
ldRouter.put('/entries/:id', updateEntry);
ldRouter.delete('/entries/:id', deleteEntry);

// Receipt
ldRouter.get('/receipt/:entryId', getReceipt);

// Manager-only: manage own agents
ldRouter.post('/users', requireManager, createLdUser);
ldRouter.get('/users', listLdUsers);  // scoped inside controller
ldRouter.patch('/users/:id/permissions', requireManager, updateLdUserPermissions);
ldRouter.patch('/users/:id/block', requireManager, toggleLdUserBlock);
ldRouter.patch('/users/:id/reset-password', requireManager, resetLdUserPassword);

// ===== ADMIN SURFACE (main admin token protects) =====
export const ldAdminRouter = express.Router();
ldAdminRouter.use(authMiddleware, checkRole(['OWNER', 'ADMIN']));

// Events
ldAdminRouter.post('/events', createEvent);
ldAdminRouter.get('/events', listEvents);
ldAdminRouter.get('/events/:id', getEvent);
ldAdminRouter.patch('/events/:id/status', updateEventStatus);
ldAdminRouter.delete('/events/:id', deleteEvent);

// Managers / agents CRUD
ldAdminRouter.post('/users', createLdUser);
ldAdminRouter.get('/users', listLdUsers);
ldAdminRouter.patch('/users/:id/permissions', updateLdUserPermissions);
ldAdminRouter.patch('/users/:id/block', toggleLdUserBlock);
ldAdminRouter.patch('/users/:id/reset-password', resetLdUserPassword);

// Admin can see ALL entries (unscoped) + logs
ldAdminRouter.get('/entries', listMyEntries);      // no scope → admin sees all
ldAdminRouter.get('/entries/event/:id', listEntriesForEvent);
ldAdminRouter.get('/receipt/:entryId', getReceipt); // admin receipt access
ldAdminRouter.get('/stats', ldDashboardStats);
ldAdminRouter.get('/activity-logs', listActivityLogs);
