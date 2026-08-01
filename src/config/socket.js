import { Server } from 'socket.io';
import { verifyToken } from '../config/jwt.js';
import pool from './db.js';
import agentLiveLocationModel from '../models/AgentLiveLocation.model.js';
import { corsOrigin } from './cors.js';

// Module-level handle so non-request code (workers) can emit without
// having to thread `app` everywhere.
let _io = null;
export const getIO = () => _io;

const ADMIN_ROLES = new Set(['ADMIN', 'OWNER']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const locationSiteCache = new Map();

const resolveLocationSite = async (locationId) => {
  if (!locationId) return null;
  const cached = locationSiteCache.get(String(locationId));
  if (cached && cached.expiresAt > Date.now()) return cached.siteId;

  const result = await pool.query(
    'SELECT site_id FROM attendance_locations WHERE id = $1 LIMIT 1',
    [locationId],
  );
  const siteId = result.rows[0]?.site_id ? String(result.rows[0].site_id) : null;
  if (siteId) {
    locationSiteCache.set(String(locationId), { siteId, expiresAt: Date.now() + 300_000 });
    if (locationSiteCache.size > 500) locationSiteCache.delete(locationSiteCache.keys().next().value);
  }
  return siteId;
};

/**
 * Emit a biometric punch to admins viewing the matching room. Safe to call
 * before sockets are ready — no-ops if io is uninitialised.
 */
export const emitAttendancePunch = (record) => {
  if (!_io || !record) return;
  void (async () => {
    try {
      const siteId = record.site_id || await resolveLocationSite(record.location_id);
      if (!siteId) return;
      const payload = { ...record, _ts: Date.now() };
      _io.to(`attendance:site:${siteId}:all`).emit('attendance:punch', payload);
      if (record.location_id) {
        _io.to(`attendance:site:${siteId}:location:${record.location_id}`).emit('attendance:punch', payload);
      }
    } catch (error) {
      console.error('Attendance socket emit failed:', error.message);
    }
  })();
};

/**
 * Initialize Socket.io for real-time chat
 */
export const initSocket = (httpServer, app) => {
  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1_000_000,
    perMessageDeflate: false,
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  // Store io instance on app for use in controllers, and at module scope
  // for workers that don't have access to the request lifecycle.
  app.set('io', io);
  _io = io;

  // Authentication middleware for socket connections
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = verifyToken(token);
      const result = await pool.query(
        'SELECT id, name, role, profile_photo, site_id, is_active, token_version FROM users WHERE id = $1 LIMIT 1',
        [decoded.id],
      );
      const dbUser = result.rows[0];
      if (!dbUser?.is_active || (decoded.version !== undefined && decoded.version !== dbUser.token_version)) {
        return next(new Error('Session expired'));
      }
      socket.user = { ...decoded, ...dbUser };
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    const siteId = socket.user.site_id ? String(socket.user.site_id) : null;
    const typingMembershipCache = new Map();
    // Join a personal room for targeted messages
    socket.join(`user_${userId}`);
    if (siteId) {
      socket.join(`site_${siteId}`);
      if (ADMIN_ROLES.has(socket.user.role)) socket.join(`site_${siteId}_admins`);
    }
    console.log(`Socket connected: user_${userId}`);

    // ── Attendance live feed rooms (admin-only) ────────────────────────
    socket.on('attendance:join', async ({ locationId } = {}) => {
      if (!ADMIN_ROLES.has(socket.user.role)) return;
      if (!siteId) return;
      if (locationId) {
        try {
          const locationSiteId = await resolveLocationSite(locationId);
          if (locationSiteId === siteId) {
            socket.join(`attendance:site:${siteId}:location:${locationId}`);
          }
        } catch (error) {
          console.error('Attendance room authorization failed:', error.message);
        }
      } else {
        socket.join(`attendance:site:${siteId}:all`);
      }
    });
    socket.on('attendance:leave', ({ locationId } = {}) => {
      if (!siteId) return;
      if (locationId) socket.leave(`attendance:site:${siteId}:location:${locationId}`);
      else socket.leave(`attendance:site:${siteId}:all`);
    });

    // Handle typing indicators
    socket.on('chat:typing', async ({ conversationId, isTyping } = {}) => {
      if (!siteId || !UUID_PATTERN.test(String(conversationId || ''))) return;
      try {
        let cached = typingMembershipCache.get(conversationId);
        if (!cached || cached.expiresAt <= Date.now()) {
          const result = await pool.query(
            `SELECT ARRAY_AGG(recipients.user_id::text) AS participant_ids
             FROM chat_participants sender
             JOIN chat_participants recipients
               ON recipients.conversation_id = sender.conversation_id
             WHERE sender.conversation_id = $1
               AND sender.user_id = $2
               AND NOT EXISTS (
                 SELECT 1
                 FROM chat_participants participant
                 JOIN users participant_user ON participant_user.id = participant.user_id
                 WHERE participant.conversation_id = sender.conversation_id
                   AND participant_user.id != $2
                   AND NOT (
                     participant_user.site_id = $3
                     OR EXISTS (
                       SELECT 1 FROM user_site_access usa
                       WHERE usa.user_id = participant_user.id AND usa.site_id = $3
                     )
                     OR EXISTS (
                       SELECT 1 FROM supervisor_site_access ssa
                       WHERE ssa.supervisor_id = participant_user.id AND ssa.site_id = $3
                     )
                   )
               )`,
            [conversationId, userId, siteId],
          );
          cached = {
            participantIds: result.rows[0]?.participant_ids || [],
            expiresAt: Date.now() + 10_000,
          };
          typingMembershipCache.set(conversationId, cached);
          if (typingMembershipCache.size > 50) {
            typingMembershipCache.delete(typingMembershipCache.keys().next().value);
          }
        }

        if (!cached.participantIds.includes(String(userId))) return;
        const payload = {
          conversationId,
          userId,
          userName: socket.user.name,
          isTyping: Boolean(isTyping),
        };
        for (const participantId of cached.participantIds) {
          if (participantId !== String(userId)) io.to(`user_${participantId}`).emit('chat:typing', payload);
        }
      } catch (error) {
        console.error('Typing authorization failed:', error.message);
      }
    });

    // Handle background location updates
    socket.on('updateLocation', async ({ latitude, longitude }) => {
      try {
        const lat = Number(latitude);
        const lng = Number(longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)
          || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          return;
        }
        // Upsert to database
        const savedRecord = await agentLiveLocationModel.upsertLocation(userId, lat, lng, pool);
        
        // Broadcast the update to all connected clients (especially Admin map)
        io.to(`site_${siteId}_admins`).emit('agentLocationUpdated', {
          user_id: userId,
          user_name: socket.user.name,
          profile_photo: socket.user.profile_photo || null,
          role: socket.user.role || 'AGENT',
          latitude: lat,
          longitude: lng,
          updated_at: savedRecord.updated_at
        });
      } catch (err) {
        console.error('Socket updateLocation error:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: user_${userId}`);
    });
  });

  return io;
};
