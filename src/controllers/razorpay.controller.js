import Razorpay from 'razorpay';
import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import financialSettingsModel from '../models/FinancialSettings.model.js';
import pool from '../config/db.js';

// Resolve the human-readable site identifier ("1", "2", or a UUID) → site UUID.
const resolveSiteId = async (rawSiteId) => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(rawSiteId)) return rawSiteId;
  const idx = parseInt(rawSiteId, 10);
  if (isNaN(idx) || idx < 1) return null;
  const r = await pool.query(
    'SELECT id FROM sites ORDER BY created_at ASC LIMIT 1 OFFSET $1',
    [idx - 1]
  );
  return r.rows[0]?.id || null;
};

// Resolve a colony name within a site → colony_map_id (or null if not found).
const resolveColonyByName = async (siteId, colonyName) => {
  if (!colonyName) return null;
  const r = await pool.query(
    'SELECT id FROM colony_maps WHERE site_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [siteId, String(colonyName).trim()]
  );
  return r.rows[0]?.id || null;
};

// Resolve effective Razorpay keys for (siteId, colonyMapId): per-colony first,
// then site-wide default, then env fallback. Fallback is per-field, not per-row —
// a per-colony row may set only `default_booking_amount` and inherit the site's
// razorpay keys (or vice versa). The admin UI promises this behaviour.
const getKeyPair = async (siteId, colonyMapId = null) => {
  const colonyRow = colonyMapId
    ? await financialSettingsModel.findByColony(siteId, colonyMapId, pool)
    : null;
  const siteRow = await financialSettingsModel.findBySite(siteId, pool);

  const key_id =
    colonyRow?.razorpay_key_id ||
    siteRow?.razorpay_key_id ||
    process.env.RAZORPAY_KEY_ID;
  const key_secret =
    colonyRow?.razorpay_key_secret ||
    siteRow?.razorpay_key_secret ||
    process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;

  // Booking amount: prefer per-colony if it's a positive number, else site default.
  const colonyAmt = parseFloat(colonyRow?.default_booking_amount);
  const siteAmt = parseFloat(siteRow?.default_booking_amount);
  const default_booking_amount =
    colonyAmt > 0 ? colonyAmt : (siteAmt > 0 ? siteAmt : 0);

  return { key_id, key_secret, default_booking_amount };
};

// ============================================================
// CREATE RAZORPAY ORDER (public)
//   body: site_id, amount, plot_label, client_name, client_phone, [colony_name]
// ============================================================
export const createRazorpayOrder = asyncHandler(async (req, res) => {
  const { site_id, amount, plot_label, client_name, client_phone, colony_name } = req.body;

  if (!site_id || !amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Site ID and valid amount are required' });
  }
  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }

  const resolvedSiteId = await resolveSiteId(site_id);
  if (!resolvedSiteId) return res.status(404).json({ success: false, message: 'Site not found' });

  const colonyMapId = await resolveColonyByName(resolvedSiteId, colony_name);

  const keys = await getKeyPair(resolvedSiteId, colonyMapId);
  if (!keys) {
    return res.status(400).json({ success: false, message: 'Payment gateway not configured for this colony' });
  }

  const razorpay = new Razorpay({ key_id: keys.key_id, key_secret: keys.key_secret });
  const amountInPaise = Math.round(Number(amount) * 100);

  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `plot_${(plot_label || 'unknown').replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`,
    notes: {
      site_id: resolvedSiteId,
      colony_map_id: colonyMapId || '',
      colony_name: colony_name || '',
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
//   body: razorpay_order_id, razorpay_payment_id, razorpay_signature, site_id, [colony_name]
// ============================================================
export const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const {
    razorpay_order_id, razorpay_payment_id, razorpay_signature,
    site_id, colony_name,
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !site_id) {
    return res.status(400).json({ success: false, message: 'Missing payment verification data' });
  }

  const resolvedSiteId = await resolveSiteId(site_id);
  if (!resolvedSiteId) return res.status(404).json({ success: false, message: 'Site not found' });

  const colonyMapId = await resolveColonyByName(resolvedSiteId, colony_name);

  const keys = await getKeyPair(resolvedSiteId, colonyMapId);
  if (!keys) return res.status(400).json({ success: false, message: 'Payment gateway not configured' });

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
// GET PUBLIC CONFIG
//   GET /razorpay/config/:siteId?colony_name=Defence%20Garden%20Phase%202
// ============================================================
export const getPublicRazorpayConfig = asyncHandler(async (req, res) => {
  const { siteId } = req.params;
  if (!siteId) return res.status(400).json({ success: false, message: 'Site ID is required' });

  const resolvedSiteId = await resolveSiteId(siteId);
  if (!resolvedSiteId) return res.status(404).json({ success: false, message: 'Site not found' });

  const colonyMapId = await resolveColonyByName(resolvedSiteId, req.query.colony_name);
  const keys = await getKeyPair(resolvedSiteId, colonyMapId);

  res.json({
    success: true,
    razorpay_enabled: !!keys,
    key_id: keys?.key_id || null,
    default_booking_amount: parseFloat(keys?.default_booking_amount) || 0,
  });
});
