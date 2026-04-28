// Mock ZKTeco K40 Pro device.
//
//   • TCP server on :4370 — speaks the binary ZK protocol so the existing
//     node-zklib-based service in src/services/zkteco.service.js can
//     connect, fetch users, fetch attendance, etc., as if a real K40
//     were present.
//   • HTTP control plane on :4371 — out-of-band commands for the test
//     runner and for manual exercising during development:
//         GET  /healthz       readiness probe
//         GET  /state         current users, punches, sessionCounter
//         POST /inject-punch  { zktecoUserId, type? = 0, time? = now }
//         POST /reset         restore the default fixture
//
// Run: `node scripts/zkteco-mock-server.js`
// Override ports with MOCK_TCP_PORT / MOCK_HTTP_PORT env vars.

import net from 'node:net';
import http from 'node:http';

import {
  COMMANDS,
  COMMAND_NAMES,
  createTCPPacket,
  tryParseTCPPacket,
  decodeIncoming,
  encodeUserRecord72,
  encodeAttendanceRecord40,
  wrapDataPayload,
  buildFreeSizesPayload,
} from './_mockZkProtocol.js';
import { defaultFixture } from './_mockFixture.js';

const TCP_PORT = parseInt(process.env.MOCK_TCP_PORT || '4370', 10);
const HTTP_PORT = parseInt(process.env.MOCK_HTTP_PORT || '4371', 10);

// ─── In-memory state ─────────────────────────────────────────────────
const state = (() => {
  const initial = defaultFixture();
  return {
    users: initial.users,
    punches: initial.punches,
    sessionCounter: 0x4d2,   // arbitrary starting session
    nextLogId: initial.punches.length + 1,
  };
})();

const resetState = () => {
  const fresh = defaultFixture();
  state.users = fresh.users;
  state.punches = fresh.punches;
  state.nextLogId = fresh.punches.length + 1;
};

// ─── Logging helpers ─────────────────────────────────────────────────
const log = (...args) => console.log('[mock-zk]', ...args);
const cmdName = (id) => COMMAND_NAMES[id] || `0x${id.toString(16)}`;

// ─── Per-socket handler ──────────────────────────────────────────────
// Each socket gets its own session id assigned on CMD_CONNECT and a
// rolling input buffer that's drained packet-by-packet.
const handleSocket = (socket) => {
  let buffer = Buffer.alloc(0);
  let sessionId = 0;
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`TCP connect ${remote}`);

  const reply = (commandId, replyId, data) => {
    const packet = createTCPPacket(commandId, sessionId, replyId, data);
    socket.write(packet);
  };

  const handlePacket = (pkt) => {
    const { commandId, replyId, payload } = decodeIncoming(pkt);
    log(`recv ${cmdName(commandId)} session=${sessionId} reply=${replyId} payload=${payload.length}B`);

    switch (commandId) {
      case COMMANDS.CMD_CONNECT: {
        sessionId = (++state.sessionCounter) & 0xffff;
        // node-zklib reads sessionId from the reply's ZK header at byte 4
        // (i.e. our `sessionId` field), so simply ACKing with that value
        // is enough.
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;
      }
      case COMMANDS.CMD_AUTH:
        // K40s with a comm key would validate here. We always succeed.
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;

      case COMMANDS.CMD_EXIT:
        reply(COMMANDS.CMD_ACK_OK, replyId);
        socket.end();
        break;

      case COMMANDS.CMD_FREE_DATA:
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;

      case COMMANDS.CMD_GET_FREE_SIZES: {
        const data = buildFreeSizesPayload({
          userCount: state.users.length,
          logCount: state.punches.length,
          logCapacity: 100_000,
        });
        reply(COMMANDS.CMD_ACK_OK, replyId, data);
        break;
      }

      case COMMANDS.CMD_DATA_WRRQ: {
        // payload[0]=0x01, payload[1]=type (0x09 users / 0x0d attendances)
        const type = payload[1];
        if (type === 0x09) {
          const records = state.users.map(encodeUserRecord72);
          const body = wrapDataPayload(records);
          reply(COMMANDS.CMD_DATA, replyId, body);
        } else if (type === 0x0d) {
          const records = state.punches.map(encodeAttendanceRecord40);
          const body = wrapDataPayload(records);
          reply(COMMANDS.CMD_DATA, replyId, body);
        } else {
          // Unknown data type — return empty data so the client doesn't hang.
          reply(COMMANDS.CMD_DATA, replyId, wrapDataPayload([]));
        }
        break;
      }

      case COMMANDS.CMD_USER_WRQ: {
        // The service in the production codebase doesn't push users, but
        // accept the command so any future code path doesn't crash.
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;
      }

      case COMMANDS.CMD_CLEAR_ATTLOG:
        state.punches = [];
        state.nextLogId = 1;
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;

      case COMMANDS.CMD_CLEAR_DATA:
        // Treat as "clear everything we have" — used rarely.
        state.punches = [];
        reply(COMMANDS.CMD_ACK_OK, replyId);
        break;

      default:
        log(`unhandled command ${cmdName(commandId)}; replying ACK_UNKNOWN`);
        reply(COMMANDS.CMD_ACK_UNKNOWN, replyId);
        break;
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Drain as many complete packets as the buffer holds.
    while (true) {
      const r = tryParseTCPPacket(buffer);
      if (!r) break;                    // need more bytes
      buffer = r.rest;
      if (r.packet) handlePacket(r.packet);
    }
  });

  socket.on('error', (err) => log(`socket error ${remote}: ${err.message}`));
  socket.on('close', () => log(`TCP close ${remote}`));
};

// ─── HTTP control plane ──────────────────────────────────────────────
const sendJSON = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readJSON = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => { raw += c.toString('utf8'); });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
  });
  req.on('error', reject);
});

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/state') {
      return sendJSON(res, 200, {
        userCount: state.users.length,
        punchCount: state.punches.length,
        sessionCounter: state.sessionCounter,
        users: state.users,
        punches: state.punches,
      });
    }
    if (req.method === 'POST' && req.url === '/inject-punch') {
      const body = await readJSON(req);
      const zktecoUserId = Number(body.zktecoUserId);
      if (!Number.isFinite(zktecoUserId)) {
        return sendJSON(res, 400, { error: 'zktecoUserId required (number)' });
      }
      const type = Number.isFinite(body.type) ? Number(body.type) : 0;
      const time = body.time ? new Date(body.time) : new Date();
      const user = state.users.find((u) => u.zktecoUserId === zktecoUserId);
      const userSn = user ? user.uid : 0;
      const punch = { logId: state.nextLogId++, userSn, zktecoUserId, time, type };
      state.punches.push(punch);
      log(`inject-punch user=${zktecoUserId} type=${type} time=${time.toISOString()}`);
      return sendJSON(res, 201, { ok: true, punch });
    }
    if (req.method === 'POST' && req.url === '/reset') {
      resetState();
      return sendJSON(res, 200, { ok: true, userCount: state.users.length, punchCount: state.punches.length });
    }
    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

// ─── Boot ────────────────────────────────────────────────────────────
const tcpServer = net.createServer(handleSocket);
tcpServer.on('error', (err) => log('TCP server error:', err.message));

const ready = (() => {
  let n = 0;
  return () => {
    n += 1;
    if (n === 2) log(`ready — TCP :${TCP_PORT}, HTTP :${HTTP_PORT}`);
  };
})();

tcpServer.listen(TCP_PORT, '127.0.0.1', () => { log(`TCP listening on :${TCP_PORT}`); ready(); });
httpServer.listen(HTTP_PORT, '127.0.0.1', () => { log(`HTTP listening on :${HTTP_PORT}`); ready(); });

const shutdown = (signal) => {
  log(`${signal} received, shutting down`);
  tcpServer.close();
  httpServer.close();
  setTimeout(() => process.exit(0), 200).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
