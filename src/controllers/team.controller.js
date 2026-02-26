import asyncHandler from '../utils/asyncHandler.js';
import teamModel from '../models/Team.model.js';
import teamTargetModel from '../models/TeamTarget.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

// ============================================================
// TEAM CRUD
// ============================================================

// Create Team
export const createTeam = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, message: 'Team name is required' });
  }

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.create({ name, site_id: adminUser.site_id }, pool);
  bustCache('cache:*:/api/teams*');
  res.status(201).json({ success: true, team });
});

// List Teams (for admin's site)
export const listTeams = asyncHandler(async (req, res) => {
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const teams = await teamModel.findBySiteWithDetails(adminUser.site_id, pool);
  res.json({ success: true, teams });
});

// Get single team
export const getTeam = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  const members = await teamModel.getMembers(id, pool);
  res.json({ success: true, team, members });
});

// Update Team
export const updateTeam = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, is_active } = req.body;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (is_active !== undefined) updateData.is_active = is_active;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: 'No data to update' });
  }

  const updated = await teamModel.update(id, updateData, pool);
  bustCache('cache:*:/api/teams*');
  res.json({ success: true, team: updated });
});

// Delete Team
export const deleteTeam = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  // Unassign all users from this team
  await pool.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [id]);
  await teamModel.delete(id, pool);
  bustCache('cache:*:/api/teams*');
  res.json({ success: true, message: 'Team deleted successfully' });
});

// ============================================================
// ASSIGN TEAM HEAD
// ============================================================

export const assignTeamHead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ success: false, message: 'user_id is required' });
  }

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  const targetUser = await userModel.findById(user_id, pool);
  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  if (targetUser.site_id !== adminUser.site_id) {
    return res.status(400).json({ success: false, message: 'User does not belong to your site' });
  }

  // Remove old head's team assignment if different
  if (team.head_id && team.head_id !== user_id) {
    await userModel.update(team.head_id, { team_id: null }, pool);
  }

  // Update team head and assign team to user (role is unchanged — agent can lead a team)
  const updated = await teamModel.update(id, { head_id: user_id }, pool);
  await userModel.update(user_id, { team_id: id }, pool);

  bustCache('cache:*:/api/teams*');
  res.json({ success: true, team: updated });
});

// ============================================================
// MOVE AGENT BETWEEN TEAMS
// ============================================================

export const moveAgent = asyncHandler(async (req, res) => {
  const { user_id, team_id } = req.body;

  if (!user_id || !team_id) {
    return res.status(400).json({ success: false, message: 'user_id and team_id are required' });
  }

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const targetUser = await userModel.findById(user_id, pool);
  if (!targetUser) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }
  if (targetUser.site_id !== adminUser.site_id) {
    return res.status(400).json({ success: false, message: 'User does not belong to your site' });
  }

  const team = await teamModel.findByIdAndSite(team_id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found in your site' });
  }

  const updated = await userModel.update(user_id, { team_id }, pool);
  bustCache('cache:*:/api/teams*');
  res.json({
    success: true,
    message: `${targetUser.name} moved to ${team.name}`,
    user: {
      id: updated.id,
      name: updated.name,
      role: updated.role,
      team_id: updated.team_id,
    },
  });
});

// ============================================================
// REMOVE TEAM MEMBER
// ============================================================

export const removeTeamMember = asyncHandler(async (req, res) => {
  const { id, userId } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No this site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  const targetUser = await userModel.findById(userId, pool);
  if (!targetUser || targetUser.site_id !== adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'User not found in your site' });
  }

  if (targetUser.team_id !== id) {
    return res.status(400).json({ success: false, message: 'User is not a member of this team' });
  }

  await userModel.update(userId, { team_id: null }, pool);
  bustCache('cache:*:/api/teams*');
  bustCache('cache:*:/api/site/*');

  res.json({ success: true, message: `${targetUser.name} removed from ${team.name}` });
});

// ============================================================
// TEAM MEMBERS PERFORMANCE (per-member breakdown)
// ============================================================

export const getTeamMembersPerformance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const user = await userModel.findById(req.user.id, pool);
  if (!user || !user.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, user.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  // Permission check: allow ADMIN/OWNER, or team head for their own team (by head_id)
  const isAdmin = ['ADMIN', 'OWNER'].includes(user.role);
  const isTeamHead = String(team.head_id) === String(user.id); // uses head_id, not role
  const isOwnTeamAgent = String(user.team_id) === String(id) && user.role === 'AGENT';
  
  if (!isAdmin && !isTeamHead && !isOwnTeamAgent) {
    return res.status(403).json({ success: false, message: 'Access denied. You do not have permission to view this team\'s performance.' });
  }

  // Get per-member performance stats
  const membersQuery = `
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone,
      u.role,
      u.is_active,
      u.created_at,
      COALESCE(lead_stats.total_leads, 0)::int as total_leads,
      COALESCE(lead_stats.new_leads, 0)::int as new_leads,
      COALESCE(lead_stats.interested_leads, 0)::int as interested_leads,
      COALESCE(lead_stats.booked_leads, 0)::int as booked_leads,
      COALESCE(call_stats.total_calls, 0)::int as total_calls,
      COALESCE(call_stats.calls_today, 0)::int as calls_today,
      COALESCE(call_stats.calls_this_week, 0)::int as calls_this_week,
      COALESCE(call_stats.avg_duration, 0)::numeric as avg_call_duration,
      COALESCE(call_stats.successful_calls, 0)::int as successful_calls,
      COALESCE(booking_stats.total_bookings, 0)::int as total_bookings,
      COALESCE(booking_stats.total_revenue, 0)::numeric as total_revenue,
      COALESCE(booking_stats.completed_bookings, 0)::int as completed_bookings,
      COALESCE(followup_stats.total_followups, 0)::int as total_followups,
      COALESCE(followup_stats.completed_followups, 0)::int as completed_followups,
      CASE
        WHEN COALESCE(lead_stats.total_leads, 0) > 0
        THEN ROUND(COALESCE(booking_stats.total_bookings, 0)::numeric / lead_stats.total_leads * 100, 1)
        ELSE 0
      END as conversion_rate
    FROM users u
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_leads,
        COUNT(*) FILTER (WHERE l.status = 'NEW') as new_leads,
        COUNT(*) FILTER (WHERE l.status = 'INTERESTED') as interested_leads,
        COUNT(*) FILTER (WHERE l.status = 'BOOKED') as booked_leads
      FROM leads l WHERE l.assigned_to = u.id
    ) lead_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_calls,
        COUNT(*) FILTER (WHERE c.call_start::date = CURRENT_DATE) as calls_today,
        COUNT(*) FILTER (WHERE c.call_start >= date_trunc('week', CURRENT_DATE)) as calls_this_week,
        AVG(c.duration_seconds) as avg_duration,
        COUNT(*) FILTER (WHERE c.outcome_id IS NOT NULL) as successful_calls
      FROM calls c WHERE c.assigned_to = u.id
    ) call_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_bookings,
        COALESCE(SUM(pb.total_amount), 0) as total_revenue,
        COUNT(*) FILTER (WHERE pb.status = 'COMPLETED') as completed_bookings
      FROM plot_bookings pb WHERE pb.booked_by = u.id
    ) booking_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) as total_followups,
        COUNT(*) FILTER (WHERE f.status = 'COMPLETED') as completed_followups
      FROM followups f WHERE f.assigned_to = u.id
    ) followup_stats ON true
    WHERE u.team_id = $1
    ORDER BY
      CASE u.role WHEN 'TEAM_HEAD' THEN 1 WHEN 'AGENT' THEN 2 ELSE 3 END,
      total_revenue DESC
  `;

  // Get team daily call trend (last 30 days)
  const trendQuery = `
    SELECT
      d.date::text as date,
      COALESCE(c.count, 0)::int as calls,
      COALESCE(l.count, 0)::int as leads
    FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, '1 day') d(date)
    LEFT JOIN (
      SELECT call_start::date as dt, COUNT(*) as count
      FROM calls WHERE assigned_to IN (SELECT id FROM users WHERE team_id = $1)
      AND call_start >= CURRENT_DATE - 29
      GROUP BY dt
    ) c ON c.dt = d.date
    LEFT JOIN (
      SELECT created_at::date as dt, COUNT(*) as count
      FROM leads WHERE team_id = $1
      AND created_at >= CURRENT_DATE - 29
      GROUP BY dt
    ) l ON l.dt = d.date
    ORDER BY d.date
  `;

  // Get team lead pipeline
  const pipelineQuery = `
    SELECT
      l.status,
      COUNT(*)::int as count
    FROM leads l
    WHERE l.team_id = $1
    GROUP BY l.status
    ORDER BY
      CASE l.status
        WHEN 'NEW' THEN 1 WHEN 'CONTACTED' THEN 2 WHEN 'INTERESTED' THEN 3
        WHEN 'SITE_VISIT' THEN 4 WHEN 'NEGOTIATION' THEN 5 WHEN 'BOOKED' THEN 6
        WHEN 'LOST' THEN 7
      END
  `;

  const [membersResult, trendResult, pipelineResult] = await Promise.all([
    pool.query(membersQuery, [id]),
    pool.query(trendQuery, [id]),
    pool.query(pipelineQuery, [id]),
  ]);

  res.json({
    success: true,
    team_name: team.name,
    team_id: team.id,
    head_id: team.head_id,
    members: membersResult.rows,
    dailyTrend: trendResult.rows,
    pipeline: pipelineResult.rows,
  });
});

// ============================================================
// TEAM PERFORMANCE
// ============================================================

export const getTeamPerformance = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  // Permission check: allow ADMIN/OWNER or team head for their own team
  const isAdmin = ['ADMIN', 'OWNER'].includes(adminUser.role);
  const isTeamHead = String(team.head_id) === String(adminUser.id);
  
  if (!isAdmin && !isTeamHead) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const performance = await teamModel.getPerformance(id, pool);
  res.json({ success: true, team_name: team.name, performance });
});

// ============================================================
// TEAM TARGETS
// ============================================================

// Set / Update target
export const setTeamTarget = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { month, year, lead_target, booking_target, revenue_target } = req.body;

  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required' });
  }

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  const target = await teamTargetModel.upsert({
    team_id: id,
    month: parseInt(month),
    year: parseInt(year),
    lead_target: parseInt(lead_target) || 0,
    booking_target: parseInt(booking_target) || 0,
    revenue_target: parseFloat(revenue_target) || 0,
  }, pool);

  bustCache('cache:*:/api/teams*');
  res.json({ success: true, target });
});

// Get targets for a team
export const getTeamTargets = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const adminUser = await userModel.findById(req.user.id, pool);
  if (!adminUser || !adminUser.site_id) {
    return res.status(404).json({ success: false, message: 'No site assigned' });
  }

  const team = await teamModel.findByIdAndSite(id, adminUser.site_id, pool);
  if (!team) {
    return res.status(404).json({ success: false, message: 'Team not found' });
  }

  // Permission check: allow ADMIN/OWNER or team head for their own team
  const isAdmin = ['ADMIN', 'OWNER'].includes(adminUser.role);
  const isTeamHead = String(team.head_id) === String(adminUser.id);
  
  if (!isAdmin && !isTeamHead) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  const targets = await teamTargetModel.findByTeamWithActuals(id, pool);
  res.json({ success: true, team_name: team.name, targets });
});
