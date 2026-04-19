import asyncHandler from '../utils/asyncHandler.js';
import clientActivityModel from '../models/ClientActivity.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const getSiteId = async (userId, reqUser) => {
  if (reqUser && reqUser.site_id) return reqUser.site_id;
  const user = await userModel.findById(userId, pool);
  return user?.site_id;
};

// ============================================================
// CREATE ACTIVITY
// ============================================================
export const createActivity = asyncHandler(async (req, res) => {
  const {
    lead_id, plot_id, booking_id, activity_type, title, description,
    scheduled_at, duration_minutes, status, outcome, next_step,
    client_name, client_phone, assigned_to, location,
  } = req.body;

  if (!activity_type || !title) {
    return res.status(400).json({ success: false, message: 'Activity type and title are required' });
  }

  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const activity = await clientActivityModel.create({
    site_id: siteId,
    lead_id: lead_id || null,
    plot_id: plot_id || null,
    booking_id: booking_id || null,
    activity_type,
    title,
    description: description || null,
    scheduled_at: scheduled_at || new Date().toISOString(),
    duration_minutes: duration_minutes || 0,
    status: status || 'SCHEDULED',
    outcome: outcome || null,
    next_step: next_step || null,
    client_name: client_name || null,
    client_phone: client_phone || null,
    assigned_to: assigned_to || req.user.id,
    created_by: req.user.id,
    location: location || null,
  }, pool);

  bustCache('cache:*:/api/activities*');

  res.status(201).json({ success: true, activity });
});

// ============================================================
// GET ACTIVITIES
// ============================================================
export const getActivities = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const dbUser = await userModel.findById(req.user.id, pool);
  const { page, limit, activity_type, status, lead_id, plot_id, booking_id, date_from, date_to } = req.query;

  const filters = {
    siteId,
    activityType: activity_type,
    status,
    leadId: lead_id,
    plotId: plot_id,
    bookingId: booking_id,
    dateFrom: date_from,
    dateTo: date_to,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 20,
  };

  // Role-based scoping
  if (req.user.role === 'AGENT') {
    filters.assignedTo = req.user.id;
  }

  const result = await clientActivityModel.findWithDetails(filters, pool);
  res.json({ success: true, ...result });
});

// ============================================================
// GET SINGLE ACTIVITY
// ============================================================
export const getActivity = asyncHandler(async (req, res) => {
  const activity = await clientActivityModel.findById(req.params.id, pool);
  if (!activity) return res.status(404).json({ success: false, message: 'Activity not found' });
  res.json({ success: true, activity });
});

// ============================================================
// UPDATE ACTIVITY
// ============================================================
export const updateActivity = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await clientActivityModel.findById(id, pool);
  if (!existing) return res.status(404).json({ success: false, message: 'Activity not found' });

  const allowed = [
    'activity_type', 'title', 'description', 'scheduled_at', 'completed_at',
    'duration_minutes', 'status', 'outcome', 'next_step', 'client_name',
    'client_phone', 'assigned_to', 'location', 'lead_id', 'plot_id', 'booking_id',
  ];

  const data = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) data[field] = req.body[field];
  }

  // Auto-set completed_at when marking completed
  if (data.status === 'COMPLETED' && !data.completed_at) {
    data.completed_at = new Date().toISOString();
  }

  const updated = await clientActivityModel.update(id, data, pool);

  bustCache('cache:*:/api/activities*');

  res.json({ success: true, activity: updated });
});

// ============================================================
// DELETE ACTIVITY
// ============================================================
export const deleteActivity = asyncHandler(async (req, res) => {
  const activity = await clientActivityModel.findById(req.params.id, pool);
  if (!activity) return res.status(404).json({ success: false, message: 'Activity not found' });

  await clientActivityModel.delete(req.params.id, pool);

  bustCache('cache:*:/api/activities*');

  res.json({ success: true, message: 'Activity deleted' });
});

// ============================================================
// TODAY'S ACTIVITIES
// ============================================================
export const getTodayActivities = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;
  const activities = await clientActivityModel.findToday(siteId, assignedTo, pool);
  res.json({ success: true, activities });
});

// ============================================================
// ACTIVITY STATS
// ============================================================
export const getActivityStats = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const assignedTo = req.user.role === 'AGENT' ? req.user.id : null;
  const stats = await clientActivityModel.getStats(siteId, assignedTo, pool);
  res.json({ success: true, stats });
});
