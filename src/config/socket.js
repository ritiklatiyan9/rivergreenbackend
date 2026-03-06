import { Server } from 'socket.io';
import { verifyToken } from '../config/jwt.js';

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

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: user_${userId}`);
    });
  });

  return io;
};
