// ZK TCP protocol encoders for the mock device.
//
// All offsets and the checksum algorithm are extracted from
// node_modules/node-zklib/utils.js so the encoder is bug-compatible
// with the decoder it pairs with. Inlined (rather than imported from
// inside node_modules) so the mock has zero ESM/CJS interop pain.
//
// Wire layout for a TCP packet from the device:
//   [ TCP magic 8B ] [ ZK header 8B ] [ payload ]
//   TCP magic: 0x50 0x50 0x82 0x7d, then uint16LE length, then 2 zero bytes.
//   ZK header: cmd(2 LE) + checksum(2 LE) + sessionId(2 LE) + replyId(2 LE)
//
// The CMD_DATA payload that node-zklib expects has a 4-byte preamble it
// strips off (`data.data.subarray(4)`), then a stream of fixed-size records.

const USHRT_MAX = 65535;

export const COMMANDS = {
  CMD_CONNECT:        1000,
  CMD_EXIT:           1001,
  CMD_AUTH:           1102,
  CMD_PREPARE_DATA:   1500,
  CMD_DATA:           1501,
  CMD_FREE_DATA:      1502,
  CMD_DATA_WRRQ:      1503,
  CMD_DATA_RDY:       1504,
  CMD_USER_WRQ:       8,
  CMD_USERTEMP_RRQ:   9,
  CMD_ATTLOG_RRQ:     13,
  CMD_CLEAR_DATA:     14,
  CMD_CLEAR_ATTLOG:   15,
  CMD_GET_FREE_SIZES: 50,
  CMD_ACK_OK:         2000,
  CMD_ACK_ERROR:      2001,
  CMD_ACK_UNKNOWN:    65535,
};

// Reverse lookup for friendly logs
export const COMMAND_NAMES = Object.fromEntries(
  Object.entries(COMMANDS).map(([k, v]) => [v, k]),
);

// ─── Checksum (matches node-zklib createChkSum) ──────────────────────
const createChkSum = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i === buf.length - 1) sum += buf[i];
    else                       sum += buf.readUInt16LE(i);
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
};

// ─── Outbound packet wrapper (mirror of createTCPHeader) ─────────────
export const createTCPPacket = (command, sessionId, replyId, data = Buffer.alloc(0)) => {
  const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const buf = Buffer.alloc(8 + dataBuf.length);
  buf.writeUInt16LE(command, 0);
  buf.writeUInt16LE(0, 2);                // checksum placeholder
  buf.writeUInt16LE(sessionId & 0xffff, 4);
  buf.writeUInt16LE(replyId & 0xffff, 6);
  dataBuf.copy(buf, 8);
  buf.writeUInt16LE(createChkSum(buf), 2);

  const prefix = Buffer.from([0x50, 0x50, 0x82, 0x7d, 0x00, 0x00, 0x00, 0x00]);
  prefix.writeUInt16LE(buf.length, 4);
  return Buffer.concat([prefix, buf]);
};

// ─── Inbound packet parser ───────────────────────────────────────────
// Returns null if not enough bytes for a complete packet, otherwise
// { packet: Buffer, rest: Buffer } where `packet` is the complete one
// and `rest` is whatever's left in the input buffer.
export const tryParseTCPPacket = (buffer) => {
  if (buffer.length < 8) return null;
  // Validate magic. If it doesn't match, drop one byte and resync —
  // protects against junk bytes if a client misbehaves.
  if (!(buffer[0] === 0x50 && buffer[1] === 0x50 && buffer[2] === 0x82 && buffer[3] === 0x7d)) {
    return { packet: null, rest: buffer.subarray(1) };
  }
  const zkLen = buffer.readUInt16LE(4);
  const total = 8 + zkLen;
  if (buffer.length < total) return null;
  return { packet: buffer.subarray(0, total), rest: buffer.subarray(total) };
};

export const decodeIncoming = (packet) => {
  const zk = packet.subarray(8); // strip TCP magic
  return {
    commandId: zk.readUInt16LE(0),
    checksum:  zk.readUInt16LE(2),
    sessionId: zk.readUInt16LE(4),
    replyId:   zk.readUInt16LE(6),
    payload:   zk.subarray(8),
  };
};

// ─── Time encoding (inverse of parseTimeToDate) ──────────────────────
// node-zklib's parseTimeToDate decomposes seconds-since-2000-style packed
// integer into Y/M/D/H/M/S. To round-trip, pack it back the same way.
export const encodeZkTime = (date) => {
  const y = date.getFullYear() - 2000;
  const M = date.getMonth();        // 0-11 (matches the decoder's `month % 12`)
  const D = date.getDate() - 1;     // decoder does `day % 31 + 1`
  const h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  return ((((y * 12 + M) * 31 + D) * 24 + h) * 60 + m) * 60 + s;
};

// ─── User record (72 bytes) ──────────────────────────────────────────
// decodeUserData72 expectations:
//   uid       at 0-1   (uint16LE)
//   role      at 2     (uint8)
//   password  at 3-10  (8B ASCII)
//   name      from 11  (ASCII, null-terminated; bounded by next field)
//   cardno    at 35-38 (uint32LE)
//   userId    at 48-56 (9B ASCII)
export const encodeUserRecord72 = (u) => {
  const buf = Buffer.alloc(72);
  buf.writeUInt16LE(u.uid & 0xffff, 0);
  buf.writeUInt8((u.role ?? 0) & 0xff, 2);
  Buffer.from((u.password || '').toString().slice(0, 8), 'ascii').copy(buf, 3);
  // Name: write into the 24-byte window 11-34 (cardno starts at 35)
  Buffer.from((u.name || '').toString().slice(0, 23), 'ascii').copy(buf, 11);
  buf.writeUInt32LE((u.cardNo ?? 0) >>> 0, 35);
  // group + tz fields stay zero (39-47)
  Buffer.from(String(u.zktecoUserId ?? u.userId ?? '').slice(0, 9), 'ascii').copy(buf, 48);
  // 57-71 reserved zeros
  return buf;
};

// ─── Attendance record (40 bytes) ────────────────────────────────────
// decodeRecordData40 expectations:
//   userSn       at 0-1   (uint16LE)
//   deviceUserId at 2-10  (9B ASCII)
//   recordTime   at 27-30 (uint32LE encoded by encodeZkTime)
export const encodeAttendanceRecord40 = (p) => {
  const buf = Buffer.alloc(40);
  buf.writeUInt16LE((p.userSn ?? 0) & 0xffff, 0);
  Buffer.from(String(p.zktecoUserId).slice(0, 9), 'ascii').copy(buf, 2);
  // We deliberately leave bytes 11-26 as zero — node-zklib's
  // decodeRecordData40 doesn't read state/verify, so these slots are
  // free space. Real devices put state at byte 24 in the full SDK record;
  // unused here.
  buf.writeUInt32LE(encodeZkTime(p.time instanceof Date ? p.time : new Date(p.time)), 27);
  return buf;
};

// ─── CMD_DATA payload wrapper ────────────────────────────────────────
// node-zklib does `data.data.subarray(4)` before slicing into records,
// so we need a 4-byte preamble. By convention this holds the total
// number of bytes following; we write it for completeness even though
// the client discards it.
export const wrapDataPayload = (records) => {
  const body = Buffer.concat(records);
  const preamble = Buffer.alloc(4);
  preamble.writeUInt32LE(body.length, 0);
  return Buffer.concat([preamble, body]);
};

// ─── CMD_GET_FREE_SIZES reply (device info) ──────────────────────────
// node-zklib's getInfo() reads at offsets 24/40/72 of the buffer
// returned by executeCmd, which is `removeTcpHeader(reply)` — i.e. it
// still contains the 8-byte ZK header. So payload offsets are -8:
//   payload[16..19] → userCounts
//   payload[32..35] → logCounts
//   payload[64..67] → logCapacity
// Allocate 92 to mirror real devices (which return more fields).
export const buildFreeSizesPayload = ({ userCount, logCount, logCapacity = 100_000 }) => {
  const buf = Buffer.alloc(92);
  buf.writeUInt32LE(userCount >>> 0, 16);
  buf.writeUInt32LE(logCount  >>> 0, 32);
  buf.writeUInt32LE(logCapacity >>> 0, 64);
  return buf;
};
