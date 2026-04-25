import express from 'express';
const router = express.Router();

import authRoutes from './auth.routes.js';
import uploadRoutes from './upload.routes.js';
import adminRoutes from './admin.routes.js';
import siteRoutes from './site.routes.js';
import teamRoutes from './team.routes.js';
import userCategoryRoutes from './userCategory.routes.js';
import callRoutes from './call.routes.js';
import followupRoutes from './followup.routes.js';
import leadRoutes from './lead.routes.js';
import colonyMapRoutes from './colonyMap.routes.js';
import plotBookingRoutes from './plotBooking.routes.js';
import paymentRoutes from './payment.routes.js';
import clientRoutes from './client.routes.js';
import clientActivityRoutes from './clientActivity.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import contentShareRoutes from './contentShare.routes.js';
import attendanceRoutes from './attendance.routes.js';
import chatRoutes from './chat.routes.js';
import financialSettingsRoutes from './financialSettings.routes.js';
import contactRoutes from './contact.routes.js';
import directionsRoutes from './directions.routes.js';
import razorpayRoutes from './razorpay.routes.js';
import taskRoutes from './task.routes.js';
import categoryRoutes from './category.routes.js';
import productRoutes from './product.routes.js';
import stockRoutes from './stock.routes.js';
import supervisorRoutes from './supervisor.routes.js';
import supervisionTaskRoutes from './supervisionTask.routes.js';
import sidebarPermissionRoutes from './sidebarPermission.routes.js';
import { ldAuthRouter, ldRouter, ldAdminRouter } from './luckyDraw.routes.js';

router.use('/auth', authRoutes);
router.use('/upload', uploadRoutes);
router.use('/admin', adminRoutes);
router.use('/site', siteRoutes);
router.use('/teams', teamRoutes);
router.use('/site/user-categories', userCategoryRoutes);
router.use('/calls', callRoutes);
router.use('/followups', followupRoutes);
router.use('/leads', leadRoutes);
router.use('/colony-maps', colonyMapRoutes);
router.use('/bookings', plotBookingRoutes);
router.use('/payments', paymentRoutes);
router.use('/clients', clientRoutes);
router.use('/activities', clientActivityRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/content-share', contentShareRoutes);
router.use('/attendance', attendanceRoutes);
router.use('/chat', chatRoutes);
router.use('/financial-settings', financialSettingsRoutes);
router.use('/contacts', contactRoutes);
router.use('/directions', directionsRoutes);
router.use('/razorpay', razorpayRoutes);
router.use('/tasks', taskRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/stocks', stockRoutes);
router.use('/supervisors', supervisorRoutes);
router.use('/supervision-tasks', supervisionTaskRoutes);
router.use('/admin/sidebar-permissions', sidebarPermissionRoutes);

// Lucky Draw module
router.use('/ld-auth', ldAuthRouter);      // Lucky Draw login surface
router.use('/ld', ldRouter);               // Manager + Agent panel APIs
router.use('/admin/lucky-draw', ldAdminRouter); // Admin surface

export default router;
