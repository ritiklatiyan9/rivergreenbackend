import 'dotenv/config';
import http from 'http';

import app from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { startReminderNudge } from './services/reminderNudge.service.js';
import * as zktecoPoller from './workers/zktecoPoller.worker.js';

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// Initialize Socket.io
initSocket(server, app);

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
    // Start the 3-hourly reminder nudge after DB is ready.
    startReminderNudge();
    // Start the ZKTeco biometric poller. Disable with ZKTECO_POLLER=off.
    if (process.env.ZKTECO_POLLER !== 'off') {
      zktecoPoller.start();
    }
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });

const shutdown = (signal) => {
  console.log(`Received ${signal}, shutting down...`);
  zktecoPoller.stop();
  server.close(() => process.exit(0));
  // Hard-exit guard so a stuck connection can't keep us hanging.
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));