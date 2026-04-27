import 'dotenv/config';
import http from 'http';

import app from './app.js';
import { connectDB } from './config/db.js';
import { initSocket } from './config/socket.js';
import { startReminderNudge } from './services/reminderNudge.service.js';

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
  })
  .catch((err) => {
    console.error('Failed to start server', err);
    process.exit(1);
  });