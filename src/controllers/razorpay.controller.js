import Razorpay from 'razorpay';
import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import financialSettingsModel from '../models/FinancialSettings.model.js';
import pool from '../config/db.js';

// Helper: resolve Razorpay keys — DB settings take priority, env vars as fallback
const getKeyPair = async (siteId) => {
  const settings = await financialSettingsModel.findBySite(siteId, pool);
  const key_id = settings?.razorpay_key_id || process.env.RAZORPAY_KEY_ID;
  const key_secret = settings?.razorpay_key_secret || process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  return { key_id, key_secret, default_booking_amount: settings?.default_booking_amount };
};

// Helper: get Razorpay instance for a site
const getRazorpayInstance = async (siteId) => {
  const keys = await getKeyPair(siteId);
  if (!keys) return null;
  return new Razorpay({ key_id: keys.key_id, key_secret: keys.key_secret });
};

// ============================================================
// CREATE RAZORPAY ORDER (public — for website booking)
// ============================================================
export const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { site_id, amount, plot_label, client_name, client_phone } = req.body;

  if (!site_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Site ID and valid amount are required' });
  }
  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }

  // Resolve site_id (numeric index or UUID)
  let resolvedSiteId = site_id;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(resolvedSiteId)) {
    const idx = parseInt(resolvedSiteId, 10);
    if (isNaN(idx) || idx < 1) {
      return res.status(400).json({ success: false, message: 'Invalid site identifier' });
    }
    const siteRes = await pool.query(
      'SELECT id FROM sites ORDER BY created_at ASC LIMIT 1 OFFSET $1',
      [idx - 1]
    );
    if (siteRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }
    resolvedSiteId = siteRes.rows[0].id;
  }

  const keys = await getKeyPair(resolvedSiteId);
  if (!keys) {
    return res.status(400).json({ success: false, message: 'Payment gateway not configured for this site' });
  }

  const razorpay = new Razorpay({ key_id: keys.key_id, key_secret: keys.key_secret });

  const amountInPaise = Math.round(Number(amount) * 100);

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `plot_${(plot_label || 'unknown').replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`,
    notes: {
      site_id: resolvedSiteId,
      plot_label: plot_label || '',
      client_name,
      client_phone,
    },
  });

  res.json({
    success: true,
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    key_id: keys.key_id,
  });
});

// ============================================================
// VERIFY RAZORPAY PAYMENT (public — after checkout completes)
// ============================================================
export const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    site_id,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !site_id) {
    return res.status(400).json({ success: false, message: 'Missing payment verification data' });
  }

  // Resolve site_id
  let resolvedSiteId = site_id;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(resolvedSiteId)) {
    const idx = parseInt(resolvedSiteId, 10);
    if (isNaN(idx) || idx < 1) {
      return res.status(400).json({ success: false, message: 'Invalid site identifier' });
    }
    const siteRes = await pool.query(
      'SELECT id FROM sites ORDER BY created_at ASC LIMIT 1 OFFSET $1',
      [idx - 1]
    );
    if (siteRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }
    resolvedSiteId = siteRes.rows[0].id;
  }

  const keys = await getKeyPair(resolvedSiteId);
  if (!keys) {
    return res.status(400).json({ success: false, message: 'Payment gateway not configured' });
  }

  // Verify signature using HMAC SHA256
  const expectedSignature = crypto
    .createHmac('sha256', keys.key_secret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Payment verification failed — invalid signature' });
  }

  res.json({
    success: true,
    message: 'Payment verified successfully',
    payment_id: razorpay_payment_id,
    order_id: razorpay_order_id,
  });
});

// ============================================================
// GET PUBLIC CONFIG (returns key_id + default_booking_amount — public safe)
// ============================================================
export const getPublicRazorpayConfig = asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  if (!siteId) {
    return res.status(400).json({ success: false, message: 'Site ID is required' });
  }

  // Resolve site_id
  let resolvedSiteId = siteId;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(resolvedSiteId)) {
    const idx = parseInt(resolvedSiteId, 10);
    if (isNaN(idx) || idx < 1) {
      return res.status(400).json({ success: false, message: 'Invalid site identifier' });
    }
    const siteRes = await pool.query(
      'SELECT id FROM sites ORDER BY created_at ASC LIMIT 1 OFFSET $1',
      [idx - 1]
    );
    if (siteRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Site not found' });
    }
    resolvedSiteId = siteRes.rows[0].id;
  }

  const keys = await getKeyPair(resolvedSiteId);

  res.json({
    success: true,
    razorpay_enabled: !!keys,
    key_id: keys?.key_id || null,
    default_booking_amount: parseFloat(keys?.default_booking_amount) || 0,
  });
});
