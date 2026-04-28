import { Server } from 'socket.io';
import { verifyToken } from '../config/jwt.js';
import pool from './db.js';
import agentLiveLocationModel from '../models/AgentLiveLocation.model.js';

// Module-level handle so non-request code (workers) can emit without
// having to thread `app` everywhere.
let _io = null;
export const getIO = () => _io;

const ADMIN_ROLES = new Set(['ADMIN', 'OWNER']);

/**
 * Emit a biometric punch to admins viewing the matching room. Safe to call
 * before sockets are ready — no-ops if io is uninitialised.
 */
export const emitAttendancePunch = (record) => {
  if (!_io || !record) return;
  const payload = { ...record, _ts: Date.now() };
  _io.to(`attendance:all`).emit('attendance:punch', payload);
  if (record.location_id) {
    _io.to(`attendance:location:${record.location_id}`).emit('attendance:punch', payload);
  }
};

/**
 * Initialize Socket.io for real-time chat
 */
export const initSocket = (httpServer, app) => {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, origin || true),
      credentials: true,
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // Store io instance on app for use in controllers, and at module scope
  // for workers that don't have access to the request lifecycle.
  app.set('io', io);
  _io = io;

  // Authentication middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = verifyToken(token);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    // Join a personal room for targeted messages
    socket.join(`user_${userId}`);
    console.log(`Socket connected: user_${userId}`);

    // ── Attendance live feed rooms (admin-only) ────────────────────────
    socket.on('attendance:join', ({ locationId } = {}) => {
      if (!ADMIN_ROLES.has(socket.user.role)) return;
      if (locationId) socket.join(`attendance:location:${locationId}`);
      else socket.join('attendance:all');
    });
    socket.on('attendance:leave', ({ locationId } = {}) => {
      if (locationId) socket.leave(`attendance:location:${locationId}`);
      else socket.leave('attendance:all');
    });

    // Handle typing indicators
    socket.on('chat:typing', ({ conversationId, isTyping }) => {
      socket.broadcast.emit('chat:typing', {
        conversationId,
        userId,
        userName: socket.user.name,
        isTyping,
      });
    });

    // Handle background location updates
    socket.on('updateLocation', async ({ latitude, longitude }) => {
      try {
        // Upsert to database
        const savedRecord = await agentLiveLocationModel.upsertLocation(userId, latitude, longitude, pool);
        
        // Broadcast the update to all connected clients (especially Admin map)
        io.emit('agentLocationUpdated', {
          user_id: userId,
          user_name: socket.user.name,
          profile_photo: socket.user.profile_photo || null,
          role: socket.user.role || 'AGENT',
          latitude,
          longitude,
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
