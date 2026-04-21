import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import paymentModel from '../models/Payment.model.js';
import plotBookingModel from '../models/PlotBooking.model.js';
import mapPlotModel from '../models/MapPlot.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

/**
 * GET /api/payments/verify-receipt?token=...
 * Public endpoint — verifies an HMAC-signed farmer payment receipt token
 * issued by the Account system. Uses a shared RECEIPT_VERIFY_SECRET.
 */
export const verifyReceiptToken = (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ valid: false, message: 'Missing token' });
    }

    const decoded = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    const { payload, sig } = decoded || {};
    if (!payload || !sig) {
      return res.status(400).json({ valid: false, message: 'Malformed token' });
    }

    const expectedSig = crypto
      .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
      .update(JSON.stringify(payload))
      .digest('hex');

    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(400).json({ valid: false, message: 'Invalid or tampered receipt' });
    }

    return res.json({ valid: true, receipt: payload });
  } catch (err) {
    return res.status(400).json({ valid: false, message: 'Malformed token' });
  }
};

const getSiteId = async (userId, reqUser) => {
  if (reqUser && reqUser.site_id) return reqUser.site_id;
  const user = await userModel.findById(userId, pool);
  return user?.site_id;
};

// ============================================================
// RECORD PAYMENT
// ============================================================
export const recordPayment = asyncHandler(async (req, res) => {
  const {
    booking_id, plot_id, amount, payment_date, payment_method,
    payment_type, installment_number, transaction_id, receipt_number, notes,
    bank_name, branch_name, account_number, ifsc_code,
    upi_id, cheque_number, cheque_date, card_last4, card_network,
    payment_time, payment_reference, collected_by_name, remarks,
  } = req.body;

  // sanitize inputs: convert empty strings to undefined so PG doesn't try to parse '' as date
  const normalize = (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v);

  if (!amount) {
    return res.status(400).json({ success: false, message: 'Amount is required' });
  }

  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  // If booking_id is not provided, do not create a booking — allow payment linked to plot only
  if (!booking_id) {
    if (!plot_id) return res.status(400).json({ success: false, message: 'Either booking_id or plot_id is required' });

    // Verify plot exists
    const plot = await mapPlotModel.findById(plot_id, pool);
    if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });


     const payload = {
       site_id: siteId,
       booking_id: null,
       plot_id,
       amount: parseFloat(amount),
       payment_date: normalize(payment_date) || new Date().toISOString().slice(0, 10),
       payment_method: normalize(payment_method) || 'CASH',
       payment_type: normalize(payment_type) || 'INSTALLMENT',
       installment_number: installment_number ? Number(installment_number) : 0,
       status: 'COMPLETED',
       transaction_id: normalize(transaction_id) || null,
       receipt_number: normalize(receipt_number) || null,
       notes: normalize(notes) || null,
       bank_name: normalize(bank_name) || null,
       branch_name: normalize(branch_name) || null,
       account_number: normalize(account_number) || null,
       ifsc_code: normalize(ifsc_code) || null,
       upi_id: normalize(upi_id) || null,
       cheque_number: normalize(cheque_number) || null,
       cheque_date: normalize(cheque_date) || null,
       card_last4: normalize(card_last4) || null,
       card_network: normalize(card_network) || null,
       payment_time: normalize(payment_time) || null,
       payment_reference: normalize(payment_reference) || null,
       collected_by_name: normalize(collected_by_name) || null,
       remarks: normalize(remarks) || null,
       received_by: req.user.id,
       created_by: req.user.id,
     };

     const payment = await paymentModel.create(payload, pool);

    bustCache('cache:*:/api/payments*');
    // Do not update bookings/plots — payment-only flow
    return res.status(201).json({ success: true, payment });
  }

  // booking_id provided: validate booking exists
  const booking = await plotBookingModel.findById(booking_id, pool);
  if (!booking) {
    // if plot_id provided, create a minimal booking and the payment (backwards compatibility)
    if (!plot_id) return res.status(404).json({ success: false, message: 'Booking not found' });

    const plot = await mapPlotModel.findById(plot_id, pool);
    if (!plot) return res.status(404).json({ success: false, message: 'Plot not found' });

    const bookingPayload = {
      site_id: siteId,
      plot_id,
      colony_map_id: plot.colony_map_id,
      lead_id: null,
      client_name: normalize(req.body.client_name) || 'Walk-in',
      client_phone: normalize(req.body.client_phone) || null,
      client_email: normalize(req.body.client_email) || null,
      client_address: normalize(req.body.client_address) || null,
      booking_date: normalize(payment_date) || new Date().toISOString().slice(0, 10),
      booking_amount: parseFloat(normalize(req.body.booking_amount) || amount),
      total_amount: parseFloat(normalize(req.body.total_amount) || plot.total_price || normalize(req.body.booking_amount) || amount),
      payment_type: normalize(payment_type) || 'ONE_TIME',
      installment_count: payment_type === 'INSTALLMENT' ? (parseInt(req.body.installment_count) || 1) : 1,
      installment_frequency: req.body.installment_frequency || 'MONTHLY',
      booked_by: req.user.id,
      referred_by: null,
      notes: normalize(req.body.notes) || 'Auto-created booking for direct payment',
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const createdBooking = await plotBookingModel.create(bookingPayload, client);

      const payloadCreated = {
        site_id: siteId,
        booking_id: createdBooking.id,
        plot_id,
        amount: parseFloat(amount),
        payment_date: normalize(payment_date) || new Date().toISOString().slice(0, 10),
        payment_method: normalize(payment_method) || 'CASH',
        payment_type: normalize(payment_type) || 'INSTALLMENT',
        installment_number: installment_number ? Number(installment_number) : 0,
        status: 'COMPLETED',
        transaction_id: normalize(transaction_id) || null,
        receipt_number: normalize(receipt_number) || null,
        notes: normalize(notes) || null,
        bank_name: normalize(bank_name) || null,
        branch_name: normalize(branch_name) || null,
        account_number: normalize(account_number) || null,
        ifsc_code: normalize(ifsc_code) || null,
        upi_id: normalize(upi_id) || null,
        cheque_number: normalize(cheque_number) || null,
        cheque_date: normalize(cheque_date) || null,
        card_last4: normalize(card_last4) || null,
        card_network: normalize(card_network) || null,
        payment_time: normalize(payment_time) || null,
        payment_reference: normalize(payment_reference) || null,
        collected_by_name: normalize(collected_by_name) || null,
        remarks: normalize(remarks) || null,
        received_by: req.user.id,
        created_by: req.user.id,
      };

      const payment = await paymentModel.create(payloadCreated, client);

      await client.query(
        `UPDATE map_plots SET status = 'BOOKED', owner_name = $1, owner_phone = $2, owner_email = $3, booking_date = $4, booking_amount = $5, assigned_agent = $6, updated_by = $6, updated_at = NOW() WHERE id = $7`,
        [createdBooking.client_name, createdBooking.client_phone, createdBooking.client_email, createdBooking.booking_date, createdBooking.booking_amount, req.user.id, plot_id]
      );

      await client.query('COMMIT');
      client.release();

      bustCache('cache:*:/api/payments*');
      bustCache('cache:*:/api/bookings*');

      return res.status(201).json({ success: true, payment });
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
  }

  const payload = {
    site_id: siteId,
    booking_id,
    plot_id: plot_id || booking.plot_id,
    amount: parseFloat(amount),
    payment_date: normalize(payment_date) || new Date().toISOString().slice(0, 10),
    payment_method: normalize(payment_method) || 'CASH',
    payment_type: normalize(payment_type) || 'INSTALLMENT',
    installment_number: installment_number ? Number(installment_number) : 0,
    status: 'COMPLETED',
    transaction_id: normalize(transaction_id) || null,
    receipt_number: normalize(receipt_number) || null,
    notes: normalize(notes) || null,
    bank_name: normalize(bank_name) || null,
    branch_name: normalize(branch_name) || null,
    account_number: normalize(account_number) || null,
    ifsc_code: normalize(ifsc_code) || null,
    upi_id: normalize(upi_id) || null,
    cheque_number: normalize(cheque_number) || null,
    cheque_date: normalize(cheque_date) || null,
    card_last4: normalize(card_last4) || null,
    card_network: normalize(card_network) || null,
    payment_time: normalize(payment_time) || null,
    payment_reference: normalize(payment_reference) || null,
    collected_by_name: normalize(collected_by_name) || null,
    remarks: normalize(remarks) || null,
    received_by: req.user.id,
    created_by: req.user.id,
  };

  const payment = await paymentModel.create(payload, pool);

  bustCache('cache:*:/api/payments*');
  bustCache('cache:*:/api/bookings*');

  res.status(201).json({ success: true, payment });
});

// ============================================================
// UPDATE PAYMENT (mark pending as completed, etc.)
// ============================================================
export const updatePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await paymentModel.findById(id, pool);
  if (!existing) return res.status(404).json({ success: false, message: 'Payment not found' });

  const allowed = ['amount', 'payment_date', 'payment_method', 'status',
    'transaction_id', 'receipt_number', 'receipt_url', 'notes',
    'bank_name', 'branch_name', 'account_number', 'ifsc_code',
    'upi_id', 'cheque_number', 'cheque_date', 'card_last4', 'card_network',
    'payment_time', 'payment_reference', 'collected_by_name', 'remarks'];

  const data = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) data[field] = req.body[field];
  }

  // sanitize: remove empty-string values so PG doesn't try to parse '' as date/time
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (typeof v === 'string' && v.trim() === '') {
      delete data[k];
    }
  }

  if (req.body.status === 'COMPLETED' && existing.status === 'PENDING') {
    data.payment_date = data.payment_date || new Date().toISOString().slice(0, 10);
    data.received_by = req.user.id;
  }

  const updated = await paymentModel.update(id, data, pool);

  bustCache('cache:*:/api/payments*');
  bustCache('cache:*:/api/bookings*');

  res.json({ success: true, payment: updated });
});

// ============================================================
// GET PAYMENTS
// ============================================================
export const getPayments = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const { page, limit, status, payment_type, date_from, date_to } = req.query;

  // Agents can only see payments from their own bookings
  const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;

  const result = await paymentModel.findBySite({
    siteId,
    assignedTo,
    status,
    paymentType: payment_type,
    dateFrom: date_from,
    dateTo: date_to,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
  }, pool);

  res.json({ success: true, ...result });
});

// ============================================================
// GET PAYMENTS BY BOOKING
// ============================================================
export const getPaymentsByBooking = asyncHandler(async (req, res) => {
  const { bookingId } = req.params;
  const payments = await paymentModel.findByBooking(bookingId, pool);
  const summary = await paymentModel.getBookingSummary(bookingId, pool);
  res.json({ success: true, payments, summary });
});

// ============================================================
// GET OVERDUE PAYMENTS
// ============================================================
export const getOverduePayments = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const payments = await paymentModel.findOverdue(siteId, pool);
  res.json({ success: true, payments });
});

// ============================================================
// PAYMENT STATS
// ============================================================
export const getPaymentStats = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  // Agents see only their own stats
  const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;

  const stats = await paymentModel.getStats(siteId, pool, assignedTo);
  res.json({ success: true, stats });
});

// ============================================================
// DELETE PAYMENT (Admin only)
// ============================================================
export const deletePayment = asyncHandler(async (req, res) => {
  const payment = await paymentModel.findById(req.params.id, pool);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });

  await paymentModel.delete(req.params.id, pool);

  bustCache('cache:*:/api/payments*');
  bustCache('cache:*:/api/bookings*');

  res.json({ success: true, message: 'Payment deleted' });
});
