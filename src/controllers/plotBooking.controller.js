import asyncHandler from '../utils/asyncHandler.js';
import plotBookingModel from '../models/PlotBooking.model.js';
import paymentModel from '../models/Payment.model.js';
import mapPlotModel from '../models/MapPlot.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache, bustMany } from '../middlewares/cache.middleware.js';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import { uploadMany } from '../utils/upload.js';
import fcmService from '../services/fcm.service.js';

// Standard set of cache patterns to bust on any booking state change.
// We await these together so the response only goes out *after* L2 (Redis)
// is cleared — otherwise the frontend's immediate refetch lands on stale
// Redis data and ends up re-caching the old list / stats.
const BOOKING_CACHE_PATTERNS = [
  'cache:*:/api/colony-maps*',
  'cache:*:/api/bookings*',
  'cache:*:/api/leads*',
  'cache:*:/api/site/stats*',
  'cache:*:/api/dashboard*',
];
const bustBookingCaches = () => bustMany(...BOOKING_CACHE_PATTERNS);

// Fire-and-forget FCM helper. Runs after HTTP response so booking flow is
// never blocked by notification delivery.
const pushBookingNotification = (recipientIds, payload) => {
  const ids = [...new Set((recipientIds || []).filter(Boolean))];
  const label = payload?.data?.action || payload?.title || 'booking';
  if (ids.length === 0) {
    // Log even when nobody is targeted so missing notifications are debuggable.
    console.warn(`[booking] FCM push (${label}) skipped — no recipients`);
    return;
  }
  // Truncated id list for grep-friendly logs without leaking full UUIDs.
  const idsPreview = ids.map((u) => String(u).slice(0, 8)).join(',');
  setImmediate(async () => {
    try {
      const res = await fcmService.sendToUsers(ids, payload);
      console.log(`[booking] FCM push (${label}) -> recipients=${ids.length} [${idsPreview}] sent=${res?.sent ?? 0} failed=${res?.failed ?? 0} reason=${res?.reason ?? '-'}`);
    } catch (e) {
      console.error(`[booking] FCM notify failed (${label}):`, e?.message || e);
    }
  });
};

// Resolve every agent who has a stake in a booking. We notify all of them
// so an admin-created booking still pings the agent who owns the lead /
// holds the plot — not just whoever pressed "Save" on the booking form.
const resolveBookingStakeholders = async (booking) => {
  const ids = new Set();
  if (booking?.booked_by) ids.add(booking.booked_by);
  if (booking?.referred_by) ids.add(booking.referred_by);

  // Lead's assigned agent
  if (booking?.lead_id) {
    try {
      const r = await pool.query('SELECT assigned_to FROM leads WHERE id = $1', [booking.lead_id]);
      if (r.rows[0]?.assigned_to) ids.add(r.rows[0].assigned_to);
    } catch { /* ignore */ }
  }

  // Plot's assigned agent
  if (booking?.plot_id) {
    try {
      const r = await pool.query('SELECT assigned_agent FROM map_plots WHERE id = $1', [booking.plot_id]);
      if (r.rows[0]?.assigned_agent) ids.add(r.rows[0].assigned_agent);
    } catch { /* ignore */ }
  }

  return [...ids];
};

// Push fired specifically to the referring agent the moment their referral
// code is used to create a booking — even before admin approval. This is what
// agents actually want to see ("my code just brought in a sale").
const pushReferralUsedNotification = ({ referrerId, clientName, plotNumber, colonyName, bookingId, amount }) => {
  if (!referrerId) return;
  pushBookingNotification([referrerId], {
    title: 'Your referral was used',
    body: `${clientName || 'A customer'} booked ${plotNumber ? `plot ${plotNumber}` : 'a plot'}${colonyName ? ` in ${colonyName}` : ''}${amount ? ` (₹${amount})` : ''} — pending admin approval.`,
    data: {
      type: 'booking',
      action: 'referral_used',
      booking_id: bookingId,
      plot_number: plotNumber || '',
      client_name: clientName || '',
      colony_name: colonyName || '',
      route: bookingId ? `/bookings/${bookingId}` : '/bookings',
    },
  });
};

// Resolve a colony's display name from its UUID. Cached per-call only.
const getColonyName = async (colonyMapId) => {
  if (!colonyMapId) return '';
  try {
    const r = await pool.query('SELECT name FROM colony_maps WHERE id = $1', [colonyMapId]);
    return r.rows[0]?.name || '';
  } catch { return ''; }
};

// Resolve admins/owners at a site — used as approvers for booking requests.
const getSiteApprovers = async (siteId) => {
  if (!siteId) return [];
  const q = await pool.query(
    `SELECT id FROM users
      WHERE is_active = true
        AND role IN ('ADMIN', 'OWNER')
        AND (site_id = $1 OR role = 'OWNER')`,
    [siteId],
  );
  return q.rows.map((r) => r.id);
};

// Helper
const getSiteId = async (userId, reqUser) => {
  if (reqUser && reqUser.site_id) return reqUser.site_id;
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

  const siteId = await getSiteId(req.user.id, req.user);
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

    await bustBookingCaches();

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
    installment_frequency, notes, lead_id, ref_sponsor_code,
  } = req.body;

  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }

  const siteId = await getSiteId(req.user.id, req.user);
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

    // Resolve referring agent from sponsor code in share link
    let referredById = req.user.id; // default: the booking agent
    if (ref_sponsor_code) {
      const refAgent = await dbClient.query(
        `SELECT id FROM users WHERE UPPER(sponsor_code) = UPPER($1) AND is_active = true`,
        [ref_sponsor_code]
      );
      if (refAgent.rows.length > 0) referredById = refAgent.rows[0].id;
    }

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
      referred_by: referredById,
      status: 'PENDING_APPROVAL',
      notes: notes || `Booked by agent via shared link${ref_sponsor_code ? ` (ref: ${ref_sponsor_code})` : ''}`,
    }, dbClient);

    // Update plot to RESERVED (not BOOKED yet — awaiting admin approval)
    await dbClient.query(
      `UPDATE map_plots SET status = 'RESERVED', owner_name = $1, owner_phone = $2,
       booking_date = CURRENT_DATE, booking_amount = $3, assigned_agent = $4,
       referred_by = $5, lead_id = $6, updated_by = $4, updated_at = NOW() WHERE id = $7`,
      [client_name, client_phone, parsedBookingAmount, req.user.id, referredById, lead_id, plotId]
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

    await bustBookingCaches();

    // Notify approvers (admins + owners) that a booking needs review.
    const approverIds = await getSiteApprovers(siteId);
    const colonyName = await getColonyName(plot.colony_map_id);
    pushBookingNotification(approverIds, {
      title: 'New booking request',
      body: `${client_name} booked plot ${plot.plot_number || ''}${colonyName ? ` in ${colonyName}` : ''}`.trim(),
      data: {
        type: 'booking',
        action: 'pending_approval',
        booking_id: booking.id,
        plot_number: plot.plot_number || '',
        client_name: client_name || '',
        colony_name: colonyName,
        colony_map_id: plot.colony_map_id || '',
        route: '/bookings/approvals',
      },
    });

    // Tell the referring agent immediately when they're not the booker themselves.
    if (referredById && String(referredById) !== String(req.user.id)) {
      pushReferralUsedNotification({
        referrerId: referredById,
        clientName: client_name,
        plotNumber: plot.plot_number,
        colonyName,
        bookingId: booking.id,
        amount: parsedBookingAmount,
      });
    }

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

    await bustBookingCaches();

    const fullBooking = await plotBookingModel.findByIdFull(id, pool);

    // Notify every agent connected to this booking — booker, referrer, the
    // lead's assigned agent, and the plot's assigned agent. The approving
    // admin themselves is filtered out so admins don't notify themselves.
    const stakeholders = (await resolveBookingStakeholders(booking))
      .filter((uid) => uid !== req.user.id);
    const colonyName = fullBooking?.colony_name || await getColonyName(fullBooking?.colony_map_id || booking.colony_map_id);
    pushBookingNotification(stakeholders, {
      title: 'Booking approved',
      body: `Plot ${fullBooking?.plot_number || ''}${colonyName ? ` in ${colonyName}` : ''} booked for ${booking.client_name || 'your client'} is now confirmed.`,
      data: {
        type: 'booking',
        action: 'approved',
        booking_id: id,
        plot_number: fullBooking?.plot_number || '',
        client_name: booking.client_name || '',
        colony_name: colonyName || '',
        colony_map_id: fullBooking?.colony_map_id || booking.colony_map_id || '',
        route: `/bookings/${id}`,
      },
    });

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

    await bustBookingCaches();

    // Mirror the approve flow: ping every agent tied to this booking so the
    // person who submitted it sees the rejection in their app.
    const stakeholders = (await resolveBookingStakeholders(booking))
      .filter((uid) => uid !== req.user.id);
    const fullBooking = await plotBookingModel.findByIdFull(id, pool);
    const colonyName = fullBooking?.colony_name || await getColonyName(fullBooking?.colony_map_id || booking.colony_map_id);
    pushBookingNotification(stakeholders, {
      title: 'Booking rejected',
      body: `Plot ${fullBooking?.plot_number || ''}${colonyName ? ` in ${colonyName}` : ''} for ${booking.client_name || 'your client'} was not approved${reason ? ` — ${reason}` : ''}.`,
      data: {
        type: 'booking',
        action: 'rejected',
        booking_id: id,
        plot_number: fullBooking?.plot_number || '',
        client_name: booking.client_name || '',
        colony_name: colonyName || '',
        colony_map_id: fullBooking?.colony_map_id || booking.colony_map_id || '',
        reason: reason || '',
        route: `/bookings/${id}`,
      },
    });

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
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const { colony_map_id } = req.query;
  const result = await plotBookingModel.findBySite({
    siteId,
    status: 'PENDING_APPROVAL',
    colonyMapId: colony_map_id || undefined,
    page: 1,
    limit: 100,
  }, pool);
  res.json({ success: true, ...result });
});

// ============================================================
// GET BOOKINGS
// ============================================================
export const getBookings = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const { page, limit, status, plot_id, booked_by_id, colony_map_id } = req.query;
  const filters = {
    siteId,
    status,
    plotId: plot_id,
    colonyMapId: colony_map_id || undefined,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
  };

  // Agents and team heads see only bookings they booked OR were referred to them
  // (i.e. anything tied to their referral code). Admins/Owners see everything.
  const role = String(req.user.role || '').toUpperCase();
  if (role === 'AGENT' || role === 'TEAM_HEAD') {
    filters.bookedByOrReferred = req.user.id;
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

  // Agents/team heads can only view bookings tied to their referral code
  const role = String(req.user.role || '').toUpperCase();
  if (role === 'AGENT' || role === 'TEAM_HEAD') {
    const me = String(req.user.id);
    const isMine = String(booking.booked_by) === me || String(booking.referred_by) === me;
    if (!isMine) return res.status(403).json({ success: false, message: 'Not your booking' });
  }

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

    await bustBookingCaches();

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
// PUBLIC BOOKING BY LABEL (no auth — from website map, auto-creates plot if missing)
// ============================================================
export const publicBookByLabel = asyncHandler(async (req, res) => {
  const {
    plot_label, site_id, colony_name,
    client_name, client_phone, client_email, client_address,
    booking_amount, payment_method, transaction_id,
    ref_sponsor_code, remarks,
    razorpay_payment_id, razorpay_order_id,
  } = req.body;

  if (!plot_label || !site_id) {
    return res.status(400).json({ success: false, message: 'Plot label and site ID are required' });
  }
  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }
  if (!booking_amount || Number(booking_amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Valid booking amount is required' });
  }

  // Resolve site_id — accept numeric index (1-based) or UUID
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

  // Resolve colony by name when the website tells us which colony the booking
  // is for. Plot lookup + auto-create are scoped to this colony so labels like
  // "B-19" don't collide across colonies under the same site.
  let scopedColonyId = null;
  if (colony_name) {
    const cmRes = await pool.query(
      'SELECT id FROM colony_maps WHERE site_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
      [resolvedSiteId, String(colony_name).trim()]
    );
    if (cmRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Colony "${colony_name}" not found for this site` });
    }
    scopedColonyId = cmRes.rows[0].id;
  }

  const normalizedLabel = plot_label.replace(/[()]/g, '').trim().toUpperCase();

  // Try to find an existing plot by plot_number — scoped to the requested
  // colony when one was provided, otherwise across the whole site.
  let plot = null;
  const findParams = scopedColonyId
    ? [resolvedSiteId, normalizedLabel, scopedColonyId]
    : [resolvedSiteId, normalizedLabel];
  const findSql = scopedColonyId
    ? `SELECT mp.* FROM map_plots mp
       JOIN colony_maps cm ON mp.colony_map_id = cm.id
       WHERE cm.site_id = $1
         AND UPPER(REPLACE(REPLACE(mp.plot_number, '-', ''), '.', ''))
           = UPPER(REPLACE(REPLACE($2, '-', ''), '.', ''))
         AND mp.colony_map_id = $3
       LIMIT 1`
    : `SELECT mp.* FROM map_plots mp
       JOIN colony_maps cm ON mp.colony_map_id = cm.id
       WHERE cm.site_id = $1
         AND UPPER(REPLACE(REPLACE(mp.plot_number, '-', ''), '.', ''))
           = UPPER(REPLACE(REPLACE($2, '-', ''), '.', ''))
       LIMIT 1`;
  const findRes = await pool.query(findSql, findParams);
  if (findRes.rows.length > 0) {
    plot = findRes.rows[0];
  }

  // If no plot exists, auto-create it under the requested colony (or fall back
  // to the first colony / a brand-new colony when none was specified).
  if (!plot) {
    let colonyMapId = scopedColonyId;
    if (!colonyMapId) {
      const cmRes = await pool.query(
        'SELECT id FROM colony_maps WHERE site_id = $1 ORDER BY created_at ASC LIMIT 1',
        [resolvedSiteId]
      );
      if (cmRes.rows.length > 0) {
        colonyMapId = cmRes.rows[0].id;
      } else {
        // Create a default colony map for this site, using the site's name
        const siteNameRes = await pool.query('SELECT name FROM sites WHERE id = $1', [resolvedSiteId]);
        const siteName = siteNameRes.rows[0]?.name || 'Colony Map';
        const newCmId = randomUUID();
        await pool.query(
          `INSERT INTO colony_maps (id, site_id, name, image_url, image_width, image_height, created_at, updated_at)
           VALUES ($1, $2, $3, '', 1460, 1370, NOW(), NOW())`,
          [newCmId, resolvedSiteId, siteName]
        );
        colonyMapId = newCmId;
      }
    }
    const newPlotId = randomUUID();
    await pool.query(
      `INSERT INTO map_plots (id, colony_map_id, site_id, plot_number, polygon_points, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 'AVAILABLE', NOW(), NOW())`,
      [newPlotId, colonyMapId, resolvedSiteId, normalizedLabel]
    );
    const freshRes = await pool.query('SELECT * FROM map_plots WHERE id = $1', [newPlotId]);
    plot = freshRes.rows[0];
  }

  if (plot.status !== 'AVAILABLE') {
    return res.status(400).json({ success: false, message: `Plot is ${plot.status} and cannot be booked` });
  }

  // Upload screenshots
  let screenshotUrls = [];
  if (req.files && req.files.length > 0) {
    const results = await uploadMany(req.files, 's3');
    screenshotUrls = results.map(r => r.secure_url);
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const parsedBookingAmount = parseFloat(booking_amount);

    // Resolve referring agent
    let referredById = null;
    if (ref_sponsor_code) {
      const refAgent = await dbClient.query(
        'SELECT id FROM users WHERE UPPER(sponsor_code) = UPPER($1) AND is_active = true',
        [ref_sponsor_code]
      );
      if (refAgent.rows.length > 0) referredById = refAgent.rows[0].id;
    }

    const bookingId = randomUUID();
    const booking = await plotBookingModel.create({
      id: bookingId,
      site_id: resolvedSiteId,
      plot_id: plot.id,
      colony_map_id: plot.colony_map_id,
      client_name,
      client_phone,
      client_email: client_email || null,
      client_address: client_address || null,
      booking_date: new Date().toISOString().slice(0, 10),
      booking_amount: parsedBookingAmount,
      total_amount: parsedBookingAmount,
      payment_type: 'ONE_TIME',
      installment_count: 1,
      installment_frequency: 'MONTHLY',
      referred_by: referredById,
      status: 'PENDING_APPROVAL',
      booking_source: 'PUBLIC',
      screenshot_urls: JSON.stringify(screenshotUrls),
      notes: remarks || `Public booking from website map${ref_sponsor_code ? ` (ref: ${ref_sponsor_code})` : ''}${razorpay_payment_id ? ` [Razorpay: ${razorpay_payment_id}]` : ''}`,
    }, dbClient);

    // Update plot to RESERVED
    await dbClient.query(
      `UPDATE map_plots SET status = 'RESERVED', owner_name = $1, owner_phone = $2,
       booking_date = CURRENT_DATE, booking_amount = $3,
       referred_by = $4, updated_at = NOW() WHERE id = $5`,
      [client_name, client_phone, parsedBookingAmount, referredById, plot.id]
    );

    // Create payment record
    const isRazorpayPaid = !!razorpay_payment_id;
    await paymentModel.create({
      site_id: resolvedSiteId,
      booking_id: booking.id,
      plot_id: plot.id,
      amount: parsedBookingAmount,
      payment_date: new Date().toISOString().slice(0, 10),
      payment_method: payment_method || 'RAZORPAY',
      payment_type: 'BOOKING',
      installment_number: 0,
      status: isRazorpayPaid ? 'COMPLETED' : 'PENDING',
      transaction_id: transaction_id || razorpay_payment_id || null,
      screenshot_urls: JSON.stringify(screenshotUrls),
      notes: razorpay_payment_id ? `Razorpay payment: ${razorpay_payment_id} (Order: ${razorpay_order_id || 'N/A'})` : 'Public booking payment (pending approval)',
    }, dbClient);

    await dbClient.query('COMMIT');

    await bustBookingCaches();

    // Notify admins/owners of this site that a public booking arrived.
    const approverIds = await getSiteApprovers(resolvedSiteId);
    const paid = !!razorpay_payment_id;
    const colonyNameNotif = colony_name || await getColonyName(plot.colony_map_id);
    pushBookingNotification(approverIds, {
      title: paid
        ? `New paid booking — ${colonyNameNotif || 'website'}`
        : `New website booking — ${colonyNameNotif || 'public'}`,
      body: `${client_name} booked plot ${plot.plot_number || normalizedLabel}${colonyNameNotif ? ` in ${colonyNameNotif}` : ''}${paid ? ` — ₹${parsedBookingAmount} paid via Razorpay` : ''}`,
      data: {
        type: 'booking',
        action: 'pending_approval',
        booking_id: booking.id,
        plot_number: plot.plot_number || normalizedLabel || '',
        client_name: client_name || '',
        client_phone: client_phone || '',
        colony_name: colonyNameNotif || '',
        colony_map_id: plot.colony_map_id || '',
        amount: String(parsedBookingAmount),
        source: 'public_website',
        razorpay_payment_id: razorpay_payment_id || '',
        route: '/bookings/approvals',
      },
    });

    // Notify the referring agent immediately when their code converted.
    pushReferralUsedNotification({
      referrerId: referredById,
      clientName: client_name,
      plotNumber: plot.plot_number || normalizedLabel,
      colonyName: colonyNameNotif,
      bookingId: booking.id,
      amount: parsedBookingAmount,
    });

    res.status(201).json({ success: true, booking, message: 'Booking submitted! Admin will verify and confirm.' });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// ============================================================
// PUBLIC BOOKING (no auth — from share link)
// ============================================================
export const publicBookPlot = asyncHandler(async (req, res) => {
  const { plotId } = req.params;
  const {
    client_name, client_phone, client_email,
    booking_amount, total_amount, payment_type,
    installment_count, installment_frequency,
    payment_method, transaction_id, upi_id,
    ref_sponsor_code, remarks,
    razorpay_payment_id, razorpay_order_id,
  } = req.body;

  if (!client_name || !client_phone) {
    return res.status(400).json({ success: false, message: 'Client name and phone are required' });
  }
  if (!booking_amount || Number(booking_amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Valid booking amount is required' });
  }

  const plot = await mapPlotModel.findById(plotId, pool);
  if (!plot) {
    return res.status(404).json({ success: false, message: 'Plot not found' });
  }
  if (plot.status !== 'AVAILABLE') {
    return res.status(400).json({ success: false, message: `Plot is ${plot.status} and cannot be booked` });
  }

  const existingBooking = await plotBookingModel.findActiveByPlot(plotId, pool);
  if (existingBooking) {
    return res.status(400).json({ success: false, message: 'This plot already has an active booking' });
  }

  // Upload screenshots to S3
  let screenshotUrls = [];
  if (req.files && req.files.length > 0) {
    const results = await uploadMany(req.files, 's3');
    screenshotUrls = results.map(r => r.secure_url);
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const parsedBookingAmount = parseFloat(booking_amount || 0);
    const parsedTotalAmount = parseFloat(total_amount || booking_amount || 0);
    const parsedInstallmentCount = parseInt(installment_count) || 1;
    const freq = installment_frequency || 'MONTHLY';

    // Resolve referring agent from sponsor code in share link
    let referredById = null;
    if (ref_sponsor_code) {
      const refAgent = await dbClient.query(
        `SELECT id FROM users WHERE UPPER(sponsor_code) = UPPER($1) AND is_active = true`,
        [ref_sponsor_code]
      );
      if (refAgent.rows.length > 0) referredById = refAgent.rows[0].id;
    }

    const bookingId = randomUUID();
    const booking = await plotBookingModel.create({
      id: bookingId,
      site_id: plot.site_id,
      plot_id: plotId,
      colony_map_id: plot.colony_map_id,
      client_name,
      client_phone,
      client_email: client_email || null,
      booking_date: new Date().toISOString().slice(0, 10),
      booking_amount: parsedBookingAmount,
      total_amount: parsedTotalAmount,
      payment_type: payment_type || 'ONE_TIME',
      installment_count: parsedInstallmentCount,
      installment_frequency: freq,
      referred_by: referredById,
      status: 'PENDING_APPROVAL',
      booking_source: 'PUBLIC',
      screenshot_urls: JSON.stringify(screenshotUrls),
      notes: remarks || `Public booking via share link${ref_sponsor_code ? ` (ref: ${ref_sponsor_code})` : ''}`,
    }, dbClient);

    // Update plot to RESERVED (awaiting admin approval)
    await dbClient.query(
      `UPDATE map_plots SET status = 'RESERVED', owner_name = $1, owner_phone = $2,
       booking_date = CURRENT_DATE, booking_amount = $3,
       referred_by = $4, updated_at = NOW() WHERE id = $5`,
      [client_name, client_phone, parsedBookingAmount, referredById, plotId]
    );

    // Create initial booking payment record
    const isRazorpayPaid = !!razorpay_payment_id;
    await paymentModel.create({
      site_id: plot.site_id,
      booking_id: booking.id,
      plot_id: plotId,
      amount: parsedBookingAmount,
      payment_date: new Date().toISOString().slice(0, 10),
      payment_method: payment_method || 'RAZORPAY',
      payment_type: 'BOOKING',
      installment_number: 0,
      status: isRazorpayPaid ? 'COMPLETED' : 'PENDING',
      transaction_id: transaction_id || razorpay_payment_id || null,
      upi_id: upi_id || null,
      screenshot_urls: JSON.stringify(screenshotUrls),
      notes: razorpay_payment_id ? `Razorpay payment: ${razorpay_payment_id} (Order: ${razorpay_order_id || 'N/A'})` : 'Public booking payment (pending approval)',
    }, dbClient);

    await dbClient.query('COMMIT');

    await bustBookingCaches();

    // Notify admins/owners of this site about the public booking.
    const approverIds = await getSiteApprovers(plot.site_id);
    const paid = !!razorpay_payment_id;
    const colonyNameNotif = await getColonyName(plot.colony_map_id);
    pushBookingNotification(approverIds, {
      title: paid
        ? `New paid booking — ${colonyNameNotif || 'share link'}`
        : `New share-link booking — ${colonyNameNotif || 'public'}`,
      body: `${client_name} booked plot ${plot.plot_number || ''}${colonyNameNotif ? ` in ${colonyNameNotif}` : ''}${paid ? ` — ₹${parsedBookingAmount} paid via Razorpay` : ''}`.trim(),
      data: {
        type: 'booking',
        action: 'pending_approval',
        booking_id: booking.id,
        plot_number: plot.plot_number || '',
        client_name: client_name || '',
        client_phone: client_phone || '',
        colony_name: colonyNameNotif || '',
        colony_map_id: plot.colony_map_id || '',
        amount: String(parsedBookingAmount),
        source: 'public_share_link',
        razorpay_payment_id: razorpay_payment_id || '',
        route: '/bookings/approvals',
      },
    });

    // Notify the referring agent immediately — they want to know their
    // referral code converted, not wait for admin approval.
    pushReferralUsedNotification({
      referrerId: referredById,
      clientName: client_name,
      plotNumber: plot.plot_number,
      colonyName: colonyNameNotif,
      bookingId: booking.id,
      amount: parsedBookingAmount,
    });

    res.status(201).json({ success: true, booking, message: 'Booking submitted! Admin will verify and confirm.' });
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
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  // Agents and team heads only see stats for bookings tied to their referral code
  // (either booked by them OR referred by them).
  const role = String(req.user.role || '').toUpperCase();
  const bookedByOrReferred = (role === 'AGENT' || role === 'TEAM_HEAD') ? req.user.id : null;

  const { colony_map_id } = req.query;
  const stats = await plotBookingModel.getStats(siteId, pool, null, colony_map_id || null, bookedByOrReferred);
  res.json({ success: true, stats });
});

// ============================================================
// PUBLIC BOOKING TRACKING (no auth — customer tracking page)
// ============================================================
export const getPublicBookingStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT pb.id, pb.status, pb.booking_date, pb.booking_amount, pb.total_amount,
      pb.client_name, pb.client_phone, pb.payment_type, pb.screenshot_urls,
      pb.created_at,
      mp.plot_number, mp.block, mp.area_sqft, mp.dimensions, mp.facing, mp.plot_type,
      cm.name as colony_name,
      COALESCE(
        (SELECT SUM(amount) FROM payments p WHERE p.booking_id = pb.id AND p.status = 'COMPLETED'), 0
      ) as total_paid,
      (SELECT transaction_id FROM payments WHERE booking_id = pb.id AND payment_type = 'BOOKING' LIMIT 1) as razorpay_payment_id,
      (SELECT payment_date FROM payments WHERE booking_id = pb.id AND payment_type = 'BOOKING' LIMIT 1) as payment_date
    FROM plot_bookings pb
    LEFT JOIN map_plots mp ON pb.plot_id = mp.id
    LEFT JOIN colony_maps cm ON pb.colony_map_id = cm.id
    WHERE pb.id = $1
  `;
  const result = await pool.query(query, [id]);
  if (!result.rows[0]) {
    return res.status(404).json({ success: false, message: 'Booking not found' });
  }

  const booking = result.rows[0];
  // Only expose safe public fields
  res.json({
    success: true,
    booking: {
      id: booking.id,
      status: booking.status,
      booking_date: booking.booking_date,
      booking_amount: parseFloat(booking.booking_amount || 0),
      total_amount: parseFloat(booking.total_amount || 0),
      total_paid: parseFloat(booking.total_paid || 0),
      client_name: booking.client_name,
      client_phone: booking.client_phone?.replace(/(\d{2})\d{5}(\d{3})/, '$1*****$2'),
      payment_type: booking.payment_type,
      plot_number: booking.plot_number,
      block: booking.block,
      area_sqft: booking.area_sqft,
      dimensions: booking.dimensions,
      facing: booking.facing,
      plot_type: booking.plot_type,
      colony_name: booking.colony_name,
      razorpay_payment_id: booking.razorpay_payment_id,
      payment_date: booking.payment_date,
      screenshot_urls: booking.screenshot_urls,
      created_at: booking.created_at,
    },
  });
});

// ============================================================
// PUBLIC SCREENSHOT UPLOAD (customer adds proof)
// ============================================================
export const publicUploadScreenshots = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const booking = await plotBookingModel.findById(id, pool);
  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: 'No files uploaded' });
  }

  const results = await uploadMany(req.files, 's3');
  const newUrls = results.map(r => r.secure_url);

  // Merge with existing screenshots
  let existing = [];
  try {
    existing = typeof booking.screenshot_urls === 'string' ? JSON.parse(booking.screenshot_urls) : (booking.screenshot_urls || []);
    if (!Array.isArray(existing)) existing = [];
  } catch { existing = []; }

  const merged = [...existing, ...newUrls].slice(0, 10); // max 10

  await plotBookingModel.update(id, {
    screenshot_urls: JSON.stringify(merged),
  }, pool);

  await bustCache('cache:*:/api/bookings*');

  res.json({ success: true, screenshot_urls: merged, message: 'Screenshots uploaded successfully' });
});

// ============================================================
// SIGNED RECEIPT TOKEN  (mirrors the Account Software farmer-payment flow)
//
// Issues an HMAC-SHA256 signed token using the PLT receipt type. The token
// is verifiable on https://defencegarden.com/verify-receipt?token=… via the
// existing /api/payments/verify-receipt endpoint, since both endpoints share
// RECEIPT_VERIFY_SECRET. Short keys (t, i, pn, a, …) match the contract the
// VerifyReceipt page already understands — no frontend changes are needed
// on defencegarden.com to support this new receipt type.
// ============================================================
// Pure helper — builds the signed token + verify URL for a given booking id.
// Returns the token bundle plus the booking + payments + summary so callers
// (auth'd agent endpoint and public website endpoint) can both ship the data
// the receipt PDF needs without duplicating the lookups.
const buildSignedReceiptForBooking = async (bookingId) => {
  const booking = await plotBookingModel.findByIdFull(bookingId, pool);
  if (!booking) return { booking: null };

  const payments = await paymentModel.findByBooking(booking.id, pool);
  const summary  = await paymentModel.getBookingSummary(booking.id, pool);

  // Most recent COMPLETED payment is the "transaction" the QR certifies.
  const completed = (payments || [])
    .filter((p) => String(p.status).toUpperCase() === 'COMPLETED')
    .sort((a, b) => new Date(b.payment_date || b.created_at) - new Date(a.payment_date || a.created_at));
  const latest = completed[0] || null;

  const totalPaid = Number(summary?.total_paid || booking.total_paid || 0);
  const idShort = String(booking.id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
  // Underscores matter: VerifyReceipt.jsx on defencegarden.com renders the id
  // verbatim when it contains '_' and otherwise prepends the type prefix.
  const receiptNo = `PLT_RG_${idShort}`;

  const txnDate = latest?.payment_date
    ? new Date(latest.payment_date).toISOString().slice(0, 10)
    : (booking.booking_date
        ? new Date(booking.booking_date).toISOString().slice(0, 10)
        : new Date(booking.created_at).toISOString().slice(0, 10));

  // Short-key payload mirrors the PLT contract on the verify page.
  const payload = {
    t:  'PLT',
    i:  receiptNo,
    pn: booking.client_name || '',
    a:  totalPaid,
    dr: 'IN',
    d:  txnDate,
    pm: (latest?.payment_method || booking.payment_type || 'CASH').toUpperCase(),
    sn: booking.colony_name || 'RiverGreen',
    sy: '',
    ss: '',
    rf: booking.plot_number || '',
  };

  const sig = crypto
    .createHmac('sha256', process.env.RECEIPT_VERIFY_SECRET || '')
    .update(JSON.stringify(payload))
    .digest('hex');

  const token = Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
  const verifyBase = (process.env.RECEIPT_VERIFY_URL || 'https://www.defencegarden.com/verify-receipt').replace(/\/+$/, '');
  const verifyUrl = `${verifyBase}?token=${token}`;

  return { booking, payments, summary, token, verifyUrl, receiptNo, payload };
};

export const getBookingReceiptToken = asyncHandler(async (req, res) => {
  const result = await buildSignedReceiptForBooking(req.params.id);
  if (!result.booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  // Auth'd flow — agents/team heads can only pull their own bookings.
  const role = String(req.user.role || '').toUpperCase();
  if (role === 'AGENT' || role === 'TEAM_HEAD') {
    const me = String(req.user.id);
    const isMine = String(result.booking.booked_by) === me || String(result.booking.referred_by) === me;
    if (!isMine) return res.status(403).json({ success: false, message: 'Not your booking' });
  }

  res.json({
    success: true,
    token: result.token,
    verifyUrl: result.verifyUrl,
    receiptNo: result.receiptNo,
    payload: result.payload,
  });
});

// Public counterpart — used by the website right after a Razorpay payment
// completes. Knowing the booking UUID is the gate (UUIDs are unguessable),
// and the response also includes booking + payments so the website can
// render the same PDF without an additional auth'd round-trip.
export const getPublicBookingReceiptToken = asyncHandler(async (req, res) => {
  const result = await buildSignedReceiptForBooking(req.params.id);
  if (!result.booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  res.json({
    success: true,
    token: result.token,
    verifyUrl: result.verifyUrl,
    receiptNo: result.receiptNo,
    payload: result.payload,
    booking: result.booking,
    payments: result.payments,
    paymentSummary: result.summary,
  });
});
