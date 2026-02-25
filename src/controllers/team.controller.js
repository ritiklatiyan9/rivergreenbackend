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
    return res.status(404).json({ success: false, message: 'No site assigned' });
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

  const targets = await teamTargetModel.findByTeamWithActuals(id, pool);
  res.json({ success: true, team_name: team.name, targets });
});
