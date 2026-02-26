import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import plotBookingModel from '../models/PlotBooking.model.js';
import callModel from '../models/Call.model.js';
import leadModel from '../models/Lead.model.js';
import pool from '../config/db.js';

const getSiteId = async (userId) => {
  const user = await userModel.findById(userId, pool);
  return user?.site_id;
};

const getScopeFilters = (user) => {
  if (user.role === 'AGENT') {
    return { assignedTo: user.id };
  }
  if (user.role === 'TEAM_HEAD') {
    return { teamId: user.team_id };
  }
  return {};
};

// ============================================================
// GET COMPLETE DASHBOARD STATS
// ============================================================
export const getDashboardStats = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user || !user.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const siteId = user.site_id;
  const scope = getScopeFilters(user);

  // Fetch all data in parallel
  const [
    siteStatsRes,
    bookingStatsRes,
    callAnalyticsRes,
    leadsRes,
    bookingTrendRes,
  ] = await Promise.allSettled([
    // Site user stats
    userModel.getSiteStats(siteId, pool),
    // Booking stats
    plotBookingModel.getStats(siteId, pool, scope.assignedTo),
    // Call analytics
    callModel.getAnalytics({ siteId, ...scope }, pool),
    // Leads list - using findWithDetails with limit 100
    leadModel.findWithDetails({ site_id: siteId, assigned_to: scope.assignedTo }, 1, 100, pool),
    // Booking trend for last 30 days
    getBookingTrend(siteId, scope.assignedTo),
  ]);

  const siteStats = siteStatsRes.status === 'fulfilled' ? siteStatsRes.value : null;
  const bookingStats = bookingStatsRes.status === 'fulfilled' ? bookingStatsRes.value : null;
  const callAnalytics = callAnalyticsRes.status === 'fulfilled' ? callAnalyticsRes.value : null;
  const leadsResult = leadsRes.status === 'fulfilled' ? leadsRes.value : { items: [], pagination: {} };
  const leads = leadsResult.items || [];
  const bookingTrend = bookingTrendRes.status === 'fulfilled' ? bookingTrendRes.value : [];

  // Calculate derived metrics
  const leadTotal = leads?.length || 0;
  const conversionRate = bookingStats && leadTotal
    ? ((Number(bookingStats.completed_bookings) / leadTotal) * 100).toFixed(1)
    : null;

  // Lead pipeline breakdown
  const pipeline = {
    NEW: 0,
    CONTACTED: 0,
    INTERESTED: 0,
    SITE_VISIT: 0,
    NEGOTIATION: 0,
    BOOKED: 0,
    LOST: 0,
  };
  leads?.forEach(l => {
    if (pipeline[l.status] !== undefined) pipeline[l.status]++;
  });

  res.json({
    success: true,
    data: {
      siteStats,
      bookingStats,
      callAnalytics,
      leads: leads?.slice(0, 10) || [], // Recent leads
      leadTotal,
      pipeline,
      conversionRate,
      bookingTrend,
    },
  });
});

// Helper: Get booking trend for last 30 days
async function getBookingTrend(siteId, assignedTo) {
  try {
    const query = `
      SELECT 
        DATE(booking_date)::TEXT as date, 
        COUNT(*) as count
      FROM plot_bookings
      WHERE site_id = $1
        AND booking_date >= CURRENT_DATE - INTERVAL '30 days'
        ${assignedTo ? 'AND booked_by = $2' : ''}
      GROUP BY DATE(booking_date)::TEXT
      ORDER BY date ASC
    `;
    const params = assignedTo ? [siteId, assignedTo] : [siteId];
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error('getBookingTrend error:', err);
    return [];
  }
}

// ============================================================
// GET CONVERSION FUNNEL (Leads → Bookings → Completed)
// ============================================================
export const getConversionFunnel = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const user = await userModel.findById(req.user.id, pool);
  const scope = getScopeFilters(user);

  const query = `
    WITH lead_stats AS (
      SELECT COUNT(*) as total_leads FROM leads
      WHERE site_id = $1 ${scope.assignedTo ? 'AND assigned_to = $2' : ''}
    ),
    visited_stats AS (
      SELECT COUNT(DISTINCT l.id) as visited_leads FROM leads l
      WHERE l.site_id = $1
        AND l.status IN ('SITE_VISIT', 'NEGOTIATION', 'BOOKED')
        ${scope.assignedTo ? 'AND l.assigned_to = $2' : ''}
    ),
    booked_stats AS (
      SELECT COUNT(*) as total_bookings FROM plot_bookings
      WHERE site_id = $1 ${scope.assignedTo ? 'AND booked_by = $2' : ''}
    ),
    completed_stats AS (
      SELECT COUNT(*) as completed_bookings FROM plot_bookings
      WHERE site_id = $1
        AND status = 'COMPLETED'
        ${scope.assignedTo ? 'AND booked_by = $2' : ''}
    )
    SELECT
      (SELECT total_leads FROM lead_stats) as leads,
      (SELECT visited_leads FROM visited_stats) as site_visits,
      (SELECT total_bookings FROM booked_stats) as bookings,
      (SELECT completed_bookings FROM completed_stats) as completed
  `;

  const params = scope.assignedTo ? [siteId, scope.assignedTo] : [siteId];
  const result = await pool.query(query, params);
  const funnel = result.rows[0] || { leads: 0, site_visits: 0, bookings: 0, completed: 0 };

  // Calculate percentages
  const leadCount = Number(funnel.leads) || 1;
  res.json({
    success: true,
    funnel: {
      leads: Number(funnel.leads) || 0,
      site_visits: Number(funnel.site_visits) || 0,
      bookings: Number(funnel.bookings) || 0,
      completed: Number(funnel.completed) || 0,
      conversion_leads_to_visits: ((Number(funnel.site_visits) / leadCount) * 100).toFixed(1),
      conversion_visits_to_bookings: (Number(funnel.site_visits) > 0 ? ((Number(funnel.bookings) / Number(funnel.site_visits)) * 100).toFixed(1) : 0),
      conversion_bookings_to_completed: (Number(funnel.bookings) > 0 ? ((Number(funnel.completed) / Number(funnel.bookings)) * 100).toFixed(1) : 0),
    },
  });
});

// ============================================================
// GET TEAM PERFORMANCE
// ============================================================
export const getTeamPerformance = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const query = `
    SELECT
      t.id,
      t.name as team_name,
      (SELECT name FROM users WHERE id = t.team_head_id) as team_head_name,
      COUNT(DISTINCT u.id) as member_count,
      COUNT(DISTINCT l.id) as assigned_leads,
      COUNT(DISTINCT pb.id) as total_bookings,
      COUNT(DISTINCT pb.id) FILTER (WHERE pb.status = 'COMPLETED') as completed_bookings
    FROM teams t
    LEFT JOIN users u ON u.team_id = t.id
    LEFT JOIN leads l ON l.assigned_to = u.id
    LEFT JOIN plot_bookings pb ON pb.booked_by = u.id
    WHERE t.site_id = $1
    GROUP BY t.id, t.name, t.team_head_id
    ORDER BY completed_bookings DESC
  `;

  const result = await pool.query(query, [siteId]);
  res.json({ success: true, teams: result.rows });
});
