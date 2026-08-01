import asyncHandler from '../utils/asyncHandler.js';
import userModel from '../models/User.model.js';
import plotBookingModel from '../models/PlotBooking.model.js';
import callModel from '../models/Call.model.js';
import leadModel from '../models/Lead.model.js';
import pool from '../config/db.js';

const getSiteId = async (userId, reqUser) => {
  // Prefer the site resolved by auth middleware (x-site-id header for OWNER/ADMIN).
  if (reqUser?.site_id) return reqUser.site_id;
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

const asNumber = (value) => Number(value) || 0;

const getOverviewScope = (user) => {
  if (user.role === 'AGENT') return { mode: 'USER', principalId: user.id };
  if (user.role === 'TEAM_HEAD') {
    return user.team_id
      ? { mode: 'TEAM', principalId: user.team_id }
      : { mode: 'USER', principalId: user.id };
  }
  return { mode: 'SITE', principalId: null };
};

// ============================================================
// GET MOBILE AGENT OVERVIEW
// One DB round-trip replaces the dashboard's former five API requests.
// ============================================================
export const getAgentOverview = asyncHandler(async (req, res) => {
  const siteId = req.user.site_id;
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const { mode, principalId } = getOverviewScope(req.user);
  const result = await pool.query(`
    WITH scoped_users AS MATERIALIZED (
      SELECT u.id
      FROM users u
      WHERE u.is_active = TRUE
        AND (
          ($2::text = 'SITE' AND u.site_id = $1)
          OR ($2::text = 'USER' AND u.id = $3::uuid)
          OR ($2::text = 'TEAM' AND u.site_id = $1 AND u.team_id = $3::uuid)
        )
    ),
    lead_stats AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE l.status = 'NEW')::int AS fresh,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM calls c WHERE c.site_id = l.site_id AND c.lead_id = l.id
        ))::int AS uncontacted,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM calls c
          WHERE c.site_id = l.site_id
            AND c.lead_id = l.id
            AND COALESCE(c.duration_seconds, 0) > 0
        ))::int AS matter,
        COUNT(*) FILTER (WHERE l.status = 'NEW')::int AS new_count,
        COUNT(*) FILTER (WHERE l.status = 'CONTACTED')::int AS contacted,
        COUNT(*) FILTER (WHERE l.status = 'INTERESTED')::int AS interested,
        COUNT(*) FILTER (WHERE l.status = 'NOT_INTERESTED')::int AS not_interested,
        COUNT(*) FILTER (WHERE l.status = 'SITE_VISIT')::int AS site_visit,
        COUNT(*) FILTER (WHERE l.status = 'NEGOTIATION')::int AS negotiation,
        COUNT(*) FILTER (WHERE l.status = 'BOOKED')::int AS booked,
        COUNT(*) FILTER (WHERE l.status = 'LOST')::int AS lost,
        COUNT(*) FILTER (WHERE l.status = 'INCOMING_OFF')::int AS incoming_off,
        COUNT(*) FILTER (WHERE l.status = 'SWITCH_OFF')::int AS switch_off,
        COUNT(*) FILTER (WHERE l.status = 'NOT_ANSWERING')::int AS not_answering
      FROM leads l
      WHERE l.site_id = $1
        AND ($2::text = 'SITE' OR l.owner_id IN (SELECT id FROM scoped_users)
          OR l.assigned_to IN (SELECT id FROM scoped_users))
    ),
    followup_stats AS (
      SELECT
        COUNT(*) FILTER (
          WHERE f.status IN ('PENDING', 'SNOOZED')
            AND f.scheduled_at >= CURRENT_DATE
            AND f.scheduled_at < CURRENT_DATE + INTERVAL '1 day'
        )::int AS today,
        COUNT(*) FILTER (WHERE f.status = 'PENDING' AND f.scheduled_at < NOW())::int AS overdue,
        COUNT(*) FILTER (WHERE f.status IN ('PENDING', 'SNOOZED') AND f.scheduled_at >= NOW())::int AS upcoming,
        COUNT(*) FILTER (WHERE f.status = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE f.status = 'ESCALATED')::int AS escalated
      FROM followups f
      WHERE f.site_id = $1
        AND ($2::text = 'SITE' OR f.assigned_to IN (SELECT id FROM scoped_users))
    ),
    contact_stats AS (
      SELECT COUNT(*)::int AS total
      FROM contacts c
      WHERE c.site_id = $1
        AND ($2::text = 'SITE' OR c.created_by IN (SELECT id FROM scoped_users))
    ),
    call_stats AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE COALESCE(c.duration_seconds, 0) > 0)::int AS connected,
        COUNT(*) FILTER (
          WHERE c.call_type = 'MISSED' OR c.call_status IN ('MISSED', 'FAILED')
        )::int AS missed,
        COALESCE(ROUND(AVG(c.duration_seconds)), 0)::int AS avg_duration
      FROM calls c
      WHERE c.site_id = $1
        AND c.call_start >= CURRENT_DATE
        AND c.call_start < CURRENT_DATE + INTERVAL '1 day'
        AND ($2::text = 'SITE' OR c.assigned_to IN (SELECT id FROM scoped_users))
    )
    SELECT ls.*, fs.today AS followup_today, fs.overdue, fs.upcoming,
      fs.completed AS followup_completed, fs.escalated,
      cs.total AS contact_total,
      cas.total AS call_total, cas.connected, cas.missed, cas.avg_duration
    FROM lead_stats ls
    CROSS JOIN followup_stats fs
    CROSS JOIN contact_stats cs
    CROSS JOIN call_stats cas
  `, [siteId, mode, principalId]);

  const row = result.rows[0] || {};
  const callTotal = asNumber(row.call_total);
  const connected = asNumber(row.connected);
  const upcoming = asNumber(row.upcoming);
  const overdue = asNumber(row.overdue);

  return res.json({
    success: true,
    data: {
      leads: {
        total: asNumber(row.total),
        fresh: asNumber(row.fresh),
        uncontacted: asNumber(row.uncontacted),
        matter: asNumber(row.matter),
        byStatus: {
          NEW: asNumber(row.new_count),
          CONTACTED: asNumber(row.contacted),
          INTERESTED: asNumber(row.interested),
          NOT_INTERESTED: asNumber(row.not_interested),
          SITE_VISIT: asNumber(row.site_visit),
          NEGOTIATION: asNumber(row.negotiation),
          BOOKED: asNumber(row.booked),
          LOST: asNumber(row.lost),
          INCOMING_OFF: asNumber(row.incoming_off),
          SWITCH_OFF: asNumber(row.switch_off),
          NOT_ANSWERING: asNumber(row.not_answering),
        },
      },
      followups: {
        today: asNumber(row.followup_today),
        overdue,
        upcoming,
        scheduled: upcoming,
        missed: overdue,
        completed: asNumber(row.followup_completed),
        escalated: asNumber(row.escalated),
      },
      contacts: { total: asNumber(row.contact_total) },
      calls: {
        total: callTotal,
        today: callTotal,
        connected,
        missed: asNumber(row.missed),
        avgDuration: asNumber(row.avg_duration),
        connectRate: callTotal > 0 ? Number(((connected / callTotal) * 100).toFixed(1)) : 0,
      },
      generatedAt: new Date().toISOString(),
    },
  });
});

// ============================================================
// GET COMPLETE DASHBOARD STATS
// ============================================================
export const getDashboardStats = asyncHandler(async (req, res) => {
  const user = await userModel.findById(req.user.id, pool);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  const siteId = req.user.site_id || user.site_id;
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }
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
    // Accurate aggregate + ten recent leads without fetching 100 full rows.
    leadModel.getDashboardSummary({ siteId, assignedTo: scope.assignedTo }, pool),
    // Booking trend for last 30 days
    getBookingTrend(siteId, scope.assignedTo),
  ]);

  const siteStats = siteStatsRes.status === 'fulfilled' ? siteStatsRes.value : null;
  const bookingStats = bookingStatsRes.status === 'fulfilled' ? bookingStatsRes.value : null;
  const callAnalytics = callAnalyticsRes.status === 'fulfilled' ? callAnalyticsRes.value : null;
  const leadSummary = leadsRes.status === 'fulfilled'
    ? leadsRes.value
    : { recent: [], total: 0, pipeline: {} };
  const leads = leadSummary.recent || [];
  const bookingTrend = bookingTrendRes.status === 'fulfilled' ? bookingTrendRes.value : [];

  // Calculate derived metrics
  const leadTotal = Number(leadSummary.total) || 0;
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
  for (const [status, count] of Object.entries(leadSummary.pipeline || {})) {
    if (pipeline[status] !== undefined) pipeline[status] = Number(count) || 0;
  }

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
  const siteId = await getSiteId(req.user.id, req.user);
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
// GET AGENT MATTER LEADS — per-agent count of leads with ≥1 call
// ============================================================
export const getAgentMatterLeads = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const query = `
    SELECT
      u.id              AS agent_id,
      u.name            AS agent_name,
      u.role            AS agent_role,
      COUNT(DISTINCT l.id)::int AS matter_count
    FROM users u
    LEFT JOIN leads l
      ON (l.assigned_to = u.id OR l.owner_id = u.id)
      AND l.site_id = $1
      AND EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id LIMIT 1)
    WHERE u.site_id = $1
      AND u.role IN ('AGENT', 'TEAM_HEAD')
      AND u.is_active = TRUE
    GROUP BY u.id, u.name, u.role
    ORDER BY matter_count DESC, u.name ASC
  `;

  const result = await pool.query(query, [siteId]);
  const total = result.rows.reduce((s, r) => s + (r.matter_count || 0), 0);
  res.json({ success: true, agents: result.rows, total });
});

// ============================================================
// GET TEAM PERFORMANCE
// ============================================================
export const getTeamPerformance = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const query = `
    SELECT
      t.id,
      t.name as team_name,
      (SELECT string_agg(u2.name, ', ') FROM team_heads th2 JOIN users u2 ON th2.user_id = u2.id WHERE th2.team_id = t.id) as team_head_name,
      COUNT(DISTINCT u.id) as member_count,
      COUNT(DISTINCT l.id) as assigned_leads,
      COUNT(DISTINCT pb.id) as total_bookings,
      COUNT(DISTINCT pb.id) FILTER (WHERE pb.status = 'COMPLETED') as completed_bookings
    FROM teams t
    LEFT JOIN users u ON u.team_id = t.id
    LEFT JOIN leads l ON l.assigned_to = u.id
    LEFT JOIN plot_bookings pb ON pb.booked_by = u.id
    WHERE t.site_id = $1
    GROUP BY t.id, t.name
    ORDER BY completed_bookings DESC
  `;

  const result = await pool.query(query, [siteId]);
  res.json({ success: true, teams: result.rows });
});
