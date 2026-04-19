import asyncHandler from '../utils/asyncHandler.js';
import clientModel from '../models/Client.model.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const getSiteId = async (userId, reqUser) => {
  if (reqUser && reqUser.site_id) return reqUser.site_id;
  const user = await userModel.findById(userId, pool);
  return user?.site_id;
};

export const getClients = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const page = parseInt(req.query.page) || 1;
  const limit = req.query.limit === 'all' ? -1 : parseInt(req.query.limit) || 20;
  const filters = {
    siteId,
    search: req.query.search,
    status: req.query.status,
    page,
    limit,
  };

  const result = await clientModel.findClients(filters, pool);
  res.json({ success: true, clients: result.clients, pagination: result.pagination });
});

export const getClient = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const booking = await clientModel.findById(req.params.id, pool);
  if (!booking || booking.site_id !== siteId) return res.status(404).json({ success: false, message: 'Client not found' });

  res.json({ success: true, client: booking });
});

export const updateClient = asyncHandler(async (req, res) => {
  const siteId = await getSiteId(req.user.id, req.user);
  if (!siteId) return res.status(404).json({ success: false, message: 'No site assigned' });

  const existing = await clientModel.findById(req.params.id, pool);
  if (!existing || existing.site_id !== siteId) return res.status(404).json({ success: false, message: 'Client not found' });

  // Only allow updating certain client fields — but filter to columns that actually exist in DB
  const allowed = ['client_name','client_phone','client_email','client_aadhar','client_pan','client_dob','client_occupation','client_company','nominee_name','nominee_phone','nominee_relation','registration_number','registration_date','possession_date','client_address'];
  const colRes = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'plot_bookings'`
  );
  const cols = colRes.rows.map(r => r.column_name);
  const update = {};
  allowed.forEach(k => {
    if (req.body[k] !== undefined && cols.includes(k)) update[k] = req.body[k] || null;
  });

  const updated = Object.keys(update).length ? await clientModel.updateClientInfo(req.params.id, update, pool) : existing;

  // Bust bookings/clients cache
  bustCache('cache:*:/api/clients*');
  bustCache('cache:*:/api/bookings*');

  res.json({ success: true, message: 'Client updated', client: updated });
});
