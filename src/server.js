import 'dotenv/config';
import http from 'http';

import app from './app.js';
import { closeDB, connectDB } from './config/db.js';
import { closeRedis, connectRedis } from './config/redis.js';
import { initSocket } from './config/socket.js';
import { startReminderNudge, stopReminderNudge } from './services/reminderNudge.service.js';
import { startEodCloser, stopEodCloser } from './services/attendanceEodCloser.service.js';
import * as zktecoPoller from './workers/zktecoPoller.worker.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);
server.requestTimeout = 120_000;
server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;
server.maxRequestsPerSocket = 1_000;

// Initialize Socket.io
initSocket(server, app);

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    // Redis is an optional L2 cache: never block API availability if it is
    // temporarily unavailable, but connect it during normal startup.
    connectRedis().catch((err) => {
      console.error('Redis cache unavailable; continuing with memory cache:', err.message);
    });
    // Start the 3-hourly reminder nudge after DB is ready.
    startReminderNudge();
    // Auto-close any open attendance at 23:59 server-local. Disable with
    // ATTENDANCE_EOD_CLOSER=off (e.g. in dev).
    if (process.env.ATTENDANCE_EOD_CLOSER !== 'off') {
      startEodCloser();
    }
    // Start the ZKTeco biometric poller. Disable with ZKTECO_POLLER=off.
    if (process.env.ZKTECO_POLLER !== 'off') {
      zktecoPoller.start();
    }
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });

let isShuttingDown = false;
const shutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  zktecoPoller.stop();
  stopEodCloser();
  stopReminderNudge();

  const hardExit = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 15_000);
  hardExit.unref();

  server.closeIdleConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([closeRedis(), closeDB()]);
  clearTimeout(hardExit);
  process.exit(exitCode);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  shutdown('unhandledRejection', 1);
});
