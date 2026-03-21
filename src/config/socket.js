import { Server } from 'socket.io';
import { verifyToken } from '../config/jwt.js';
import pool from './db.js';
import agentLiveLocationModel from '../models/AgentLiveLocation.model.js';

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

  // Store io instance on app for use in controllers
  app.set('io', io);

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
