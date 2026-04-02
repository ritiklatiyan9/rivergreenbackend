import express from 'express';
const router = express.Router();

import {
  createRazorpayOrder,
  verifyRazorpayPayment,
  getPublicRazorpayConfig,
} from '../controllers/razorpay.controller.js';

// All public routes (no auth needed for website booking)
router.get('/config/:siteId', getPublicRazorpayConfig);
router.post('/create-order', createRazorpayOrder);
router.post('/verify-payment', verifyRazorpayPayment);

export default router;
