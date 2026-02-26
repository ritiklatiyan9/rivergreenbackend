import asyncHandler from '../utils/asyncHandler.js';
import plotBookingModel from '../models/PlotBooking.model.js';
import paymentModel from '../models/Payment.model.js';
import mapPlotModel from '../models/MapPlot.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';
import { randomUUID } from 'crypto';

// Helper
const getSiteId = async (userId) => {
  const user = await userModel.findById(userId, pool);
  return user?.site_id;
};

// ============================================================
// CREATE BOOKING
// ============================================================
export const createBooking = asyncHandler(async (req, res) => {
  const {
    plot_id, colony_map_id, lead_id,
    client_name, client_phone, client_email, client_address,
    booking_date, booking_amount, total_amount,
    payment_type, installment_count, installment_frequency,
    notes, referred_by,
  } = req.body;

  if (!plot_id || !client_name || !booking_amount) {
    return res.status(400).json({ success: false, message: 'Plot, client name, and booking amount are required' });
  }

  const siteId = await getSiteId(req.user.id);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  // Check plot is available
  const plot = await mapPlotModel.findById(plot_id, pool);
  if (!plot) {
    return res.status(404).json({ success: false, message: 'Plot not found' });
  }
  if (plot.status !== 'AVAILABLE') {
    return res.status(400).json({ success: false, message: `Plot is currently ${plot.status} and cannot be booked` });
  }

  // Check no active booking exists
  const existingBooking = await plotBookingModel.findActiveByPlot(plot_id, pool);
  if (existingBooking) {
    return res.status(400).json({ success: false, message: 'This plot already has an active booking' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create booking (generate id server-side if not provided)
    const bookingId = req.body.id || randomUUID();
    // Create booking
    const booking = await plotBookingModel.create({
      id: bookingId,
      site_id: siteId,
      plot_id,
      colony_map_id: colony_map_id || plot.colony_map_id,
      lead_id: lead_id || null,
      client_name,
      client_phone: client_phone || null,
      client_email: client_email || null,
      client_address: client_address || null,
      booking_date: booking_date || new Date().toISOString().slice(0, 10),
      booking_amount: parseFloat(booking_amount),
      total_amount: parseFloat(total_amount || booking_amount),
      payment_type: payment_type || 'ONE_TIME',
      installment_count: payment_type === 'INSTALLMENT' ? (parseInt(installment_count) || 12) : 1,
      installment_frequency: installment_frequency || 'MONTHLY',
      booked_by: req.user.id,
      referred_by: referred_by || null,
      notes: notes || null,
    }, client);

    // Update plot status to BOOKED
    await client.query(
      `UPDATE map_plots SET status = 'BOOKED', owner_name = $1, owner_phone = $2, owner_email = $3,
       booking_date = $4, booking_amount = $5, lead_id = $6, assigned_agent = $7, updated_by = $8, updated_at = NOW()
       WHERE id = $9`,
      [client_name, client_phone, client_email, booking_date || new Date().toISOString().slice(0, 10),
       booking_amount, lead_id, req.user.id, req.user.id, plot_id]
    );

    // Create initial booking payment record
    await paymentModel.create({
      site_id: siteId,
      booking_id: booking.id,
      plot_id,
      amount: parseFloat(booking_amount),
      payment_date: booking_date || new Date().toISOString().slice(0, 10),
      payment_method: req.body.payment_method || 'CASH',
      payment_type: 'BOOKING',
      installment_number: 0,
      status: 'COMPLETED',
      transaction_id: req.body.transaction_id || null,
      receipt_number: req.body.receipt_number || null,
      notes: 'Initial booking payment',
      received_by: req.user.id,
      created_by: req.user.id,
    }, client);

    // Generate installment schedule if payment_type is INSTALLMENT
    if (payment_type === 'INSTALLMENT' && installment_count > 1) {
      const totalAfterBooking = parseFloat(total_amount || 0) - parseFloat(booking_amount);
      const installmentAmount = Math.ceil(totalAfterBooking / (parseInt(installment_count) - 1));
      const bookDate = new Date(booking_date || Date.now());

      for (let i = 1; i < parseInt(installment_count); i++) {
        let dueDate = new Date(bookDate);
        switch (installment_frequency) {
          case 'WEEKLY': dueDate.setDate(dueDate.getDate() + (7 * i)); break;
          case 'MONTHLY': dueDate.setMonth(dueDate.getMonth() + i); break;
          case 'QUARTERLY': dueDate.setMonth(dueDate.getMonth() + (3 * i)); break;
          case 'HALF_YEARLY': dueDate.setMonth(dueDate.getMonth() + (6 * i)); break;
          case 'YEARLY': dueDate.setFullYear(dueDate.getFullYear() + i); break;
          default: dueDate.setMonth(dueDate.getMonth() + i);
        }

        await paymentModel.create({
          site_id: siteId,
          booking_id: booking.id,
          plot_id,
          amount: i === parseInt(installment_count) - 1
            ? totalAfterBooking - (installmentAmount * (parseInt(installment_count) - 2))
            : installmentAmount,
          payment_date: dueDate.toISOString().slice(0, 10),
          payment_method: 'CASH',
          payment_type: 'INSTALLMENT',
          installment_number: i,
          due_date: dueDate.toISOString().slice(0, 10),
          status: 'PENDING',
          notes: `Installment ${i} of ${parseInt(installment_count) - 1}`,
          created_by: req.user.id,
        }, client);
      }
    }

    // Update lead status if linked
    if (lead_id) {
      await client.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['BOOKED', lead_id]);
    }

    await client.query('COMMIT');

    bustCache('cache:*:/api/colony-maps*');
    bustCache('cache:*:/api/bookings*');
    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/stats*');
    bustCache('cache:*:/api/dashboard*');

    const fullBooking = await plotBookingModel.findByIdFull(booking.id, pool);
    res.status(201).json({ success: true, booking: fullBooking });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ============================================================
// AGENT BOOK PLOT (via shared link — authenticated agent)
// Sets status to PENDING_APPROVAL for admin confirmation
// ============================================================
export const agentBookPlot = asyncHandler(async (req, res) => {
  const { plotId } = req.params;
  const {
    client_name, client_phone, client_email, client_address,
    booking_amount, total_amount, payment_type, installment_count,
    installment_frequency, notes, lead_id,
  } = req.body;

  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }

  const siteId = await getSiteId(req.user.id);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const plot = await mapPlotModel.findById(plotId, pool);
  if (!plot) {
    return res.status(404).json({ success: false, message: 'Plot not found' });
  }
  if (plot.status !== 'AVAILABLE') {
    return res.status(400).json({ success: false, message: `Plot is ${plot.status} and cannot be booked` });
  }

  if (plot.site_id !== siteId) {
    return res.status(403).json({ success: false, message: 'Plot does not belong to your site' });
  }

  const existingBooking = await plotBookingModel.findActiveByPlot(plotId, pool);
  if (existingBooking) {
    return res.status(400).json({ success: false, message: 'This plot already has an active booking' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const parsedBookingAmount = parseFloat(booking_amount || 0);
    const parsedTotalAmount = parseFloat(total_amount || booking_amount || 0);
    const parsedInstallmentCount = parseInt(installment_count) || 1;
    const freq = installment_frequency || 'MONTHLY';

    const bookingId = req.body.id || randomUUID();
    const booking = await plotBookingModel.create({
      id: bookingId,
      site_id: siteId,
      plot_id: plotId,
      colony_map_id: plot.colony_map_id,
      lead_id: lead_id || null,
      client_name,
      client_phone,
      client_email: client_email || null,
      client_address: client_address || null,
      booking_date: new Date().toISOString().slice(0, 10),
      booking_amount: parsedBookingAmount,
      total_amount: parsedTotalAmount,
      payment_type: payment_type || 'ONE_TIME',
      installment_count: parsedInstallmentCount,
      installment_frequency: freq,
      booked_by: req.user.id,
      referred_by: req.user.id,
      status: 'PENDING_APPROVAL',
      notes: notes || `Booked by agent via shared link`,
    }, dbClient);

    // Update plot to RESERVED (not BOOKED yet — awaiting admin approval)
    await dbClient.query(
      `UPDATE map_plots SET status = 'RESERVED', owner_name = $1, owner_phone = $2,
       booking_date = CURRENT_DATE, booking_amount = $3, assigned_agent = $4,
       lead_id = $5, updated_by = $4, updated_at = NOW() WHERE id = $6`,
      [client_name, client_phone, parsedBookingAmount, req.user.id, lead_id, plotId]
    );

    // Create initial booking payment record (PENDING until approved)
    await paymentModel.create({
      site_id: siteId,
      booking_id: booking.id,
      plot_id: plotId,
      amount: parsedBookingAmount,
      payment_date: new Date().toISOString().slice(0, 10),
      payment_method: req.body.payment_method || 'CASH',
      payment_type: 'BOOKING',
      installment_number: 0,
      status: 'PENDING',
      notes: 'Initial booking payment (pending approval)',
      created_by: req.user.id,
    }, dbClient);

    // Generate installment schedule if payment_type is INSTALLMENT
    if (payment_type === 'INSTALLMENT' && parsedInstallmentCount > 1) {
      const totalAfterBooking = parsedTotalAmount - parsedBookingAmount;
      const installmentAmount = Math.ceil(totalAfterBooking / (parsedInstallmentCount - 1));
      const bookDate = new Date();

      for (let i = 1; i < parsedInstallmentCount; i++) {
        let dueDate = new Date(bookDate);
        switch (freq) {
          case 'WEEKLY': dueDate.setDate(dueDate.getDate() + (7 * i)); break;
          case 'MONTHLY': dueDate.setMonth(dueDate.getMonth() + i); break;
          case 'QUARTERLY': dueDate.setMonth(dueDate.getMonth() + (3 * i)); break;
          case 'HALF_YEARLY': dueDate.setMonth(dueDate.getMonth() + (6 * i)); break;
          case 'YEARLY': dueDate.setFullYear(dueDate.getFullYear() + i); break;
          default: dueDate.setMonth(dueDate.getMonth() + i);
        }

        await paymentModel.create({
          site_id: siteId,
          booking_id: booking.id,
          plot_id: plotId,
          amount: i === parsedInstallmentCount - 1
            ? totalAfterBooking - (installmentAmount * (parsedInstallmentCount - 2))
            : installmentAmount,
          payment_date: dueDate.toISOString().slice(0, 10),
          payment_method: 'CASH',
          payment_type: 'INSTALLMENT',
          installment_number: i,
          due_date: dueDate.toISOString().slice(0, 10),
          status: 'PENDING',
          notes: `Installment ${i} of ${parsedInstallmentCount - 1}`,
          created_by: req.user.id,
        }, dbClient);
      }
    }

    await dbClient.query('COMMIT');

    bustCache('cache:*:/api/colony-maps*');
    bustCache('cache:*:/api/bookings*');

    res.status(201).json({ success: true, booking, message: 'Booking submitted for admin approval!' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// ============================================================
// APPROVE BOOKING (Admin approves agent booking)
// ============================================================
export const approveBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const booking = await plotBookingModel.findById(id, pool);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ success: false, message: 'Only pending bookings can be approved' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Update booking to ACTIVE
    await plotBookingModel.update(id, {
      status: 'ACTIVE',
      approved_by: req.user.id,
    }, dbClient);

    // Update plot to SOLD (admin approval = confirmed sale)
    await dbClient.query(
      `UPDATE map_plots SET status = 'SOLD', updated_at = NOW() WHERE id = $1`,
      [booking.plot_id]
    );

    // Mark the initial booking payment as COMPLETED
    await dbClient.query(
      `UPDATE payments SET status = 'COMPLETED', received_by = $1, payment_date = CURRENT_DATE, updated_at = NOW()
       WHERE booking_id = $2 AND payment_type = 'BOOKING' AND status = 'PENDING'`,
      [req.user.id, id]
    );

    // Update lead status if linked
    if (booking.lead_id) {
      await dbClient.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['BOOKED', booking.lead_id]);
    }

    await dbClient.query('COMMIT');

    bustCache('cache:*:/api/colony-maps*');
    bustCache('cache:*:/api/bookings*');
    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/stats*');
    bustCache('cache:*:/api/dashboard*');

    const fullBooking = await plotBookingModel.findByIdFull(id, pool);
    res.json({ success: true, booking: fullBooking, message: 'Booking approved!' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// ============================================================
// REJECT BOOKING (Admin rejects agent booking)
// ============================================================
export const rejectBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const booking = await plotBookingModel.findById(id, pool);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.status !== 'PENDING_APPROVAL') {
    return res.status(400).json({ success: false, message: 'Only pending bookings can be rejected' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Cancel booking
    await plotBookingModel.update(id, {
      status: 'CANCELLED',
      notes: reason ? `Rejected: ${reason}` : 'Rejected by admin',
    }, dbClient);

    // Reset plot to AVAILABLE
    await dbClient.query(
      `UPDATE map_plots SET status = 'AVAILABLE', owner_name = NULL, owner_phone = NULL, owner_email = NULL,
       booking_date = NULL, booking_amount = NULL, updated_at = NOW() WHERE id = $1`,
      [booking.plot_id]
    );

    // Cancel all pending payments
    await dbClient.query(
      `UPDATE payments SET status = 'CANCELLED', updated_at = NOW() WHERE booking_id = $1 AND status = 'PENDING'`,
      [id]
    );

    await dbClient.query('COMMIT');

    bustCache('cache:*:/api/colony-maps*');
    bustCache('cache:*:/api/bookings*');

    res.json({ success: true, message: 'Booking rejected' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// ============================================================
// GET PENDING APPROVALS (for admin)
// ============================================================
export const getPendingApprovals = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const result = await plotBookingModel.findBySite({
    siteId,
    status: 'PENDING_APPROVAL',
    page: 1,
    limit: 100,
  }, pool);
  res.json({ success: true, ...result });
});

// ============================================================
// GET BOOKINGS
// ============================================================
export const getBookings = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const { page, limit, status, plot_id, booked_by_id } = req.query;
  const filters = {
    siteId,
    status,
    plotId: plot_id,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
  };

  // Agents only see their bookings; admins can filter by booked_by_id
  if (req.user.role === 'AGENT') {
    filters.bookedBy = req.user.id;
  } else if (booked_by_id) {
    filters.bookedBy = booked_by_id;
  }

  const result = await plotBookingModel.findBySite(filters, pool);
  res.json({ success: true, ...result });
});

// ============================================================
// GET SINGLE BOOKING
// ============================================================
export const getBooking = asyncHandler(async (req, res) => {
  const booking = await plotBookingModel.findByIdFull(req.params.id, pool);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  // Get payments
  const payments = await paymentModel.findByBooking(booking.id, pool);
  const paymentSummary = await paymentModel.getBookingSummary(booking.id, pool);

  // Ensure booking has a sensible total_amount: prefer booking.total_amount, then plot price, then booking_amount
  booking.total_amount = booking.total_amount || booking.plot_price || booking.booking_amount || 0;

  res.json({ success: true, booking, payments, paymentSummary });
});

// ============================================================
// UPDATE BOOKING STATUS
// ============================================================
export const updateBookingStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['ACTIVE', 'COMPLETED', 'CANCELLED', 'TRANSFERRED', 'PENDING_APPROVAL'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }

  const booking = await plotBookingModel.findById(id, pool);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await plotBookingModel.update(id, { status }, dbClient);

    // Update plot status based on booking status
    if (status === 'COMPLETED') {
      await dbClient.query('UPDATE map_plots SET status = $1, updated_at = NOW() WHERE id = $2', ['SOLD', booking.plot_id]);
      // Update linked lead status to BOOKED
      if (booking.lead_id) {
        await dbClient.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', ['BOOKED', booking.lead_id]);
      }
    } else if (status === 'CANCELLED') {
      await dbClient.query(
        `UPDATE map_plots SET status = 'AVAILABLE', owner_name = NULL, owner_phone = NULL, owner_email = NULL,
         booking_date = NULL, booking_amount = NULL, updated_at = NOW() WHERE id = $1`,
        [booking.plot_id]
      );
      // Cancel pending payments
      await dbClient.query(
        `UPDATE payments SET status = 'CANCELLED', updated_at = NOW() WHERE booking_id = $1 AND status = 'PENDING'`,
        [id]
      );
    }

    await dbClient.query('COMMIT');

    bustCache('cache:*:/api/colony-maps*');
    bustCache('cache:*:/api/bookings*');
    bustCache('cache:*:/api/leads*');
    bustCache('cache:*:/api/site/stats*');
    bustCache('cache:*:/api/dashboard*');

    const updated = await plotBookingModel.findByIdFull(id, pool);
    res.json({ success: true, booking: updated });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// ============================================================
// BOOKING STATS
// ============================================================
export const getBookingStats = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  // Agents only see stats for their own bookings
  const bookedBy = req.user.role === 'AGENT' ? req.user.id : null;

  const stats = await plotBookingModel.getStats(siteId, pool, bookedBy);
  res.json({ success: true, stats });
});
