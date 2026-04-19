// Lucky Draw Controllers
// Handles: LD auth (login/refresh/me), users (manager/agent CRUD), events,
// entries + receipt generation, admin metrics.
//
// Visibility rules (ENFORCED AT DB QUERY LEVEL):
//   - Admin (main system) → everything
//   - Manager            → only their own agents + entries those agents created
//   - Agent              → only their own entries

import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import {
  signLdAccessToken,
  signLdRefreshToken,
  verifyLdRefreshToken,
  hashLdPassword,
  compareLdPassword,
} from '../config/ldJwt.js';

const MANAGER_ROLES = ['PRIME_MANAGER', 'GENERAL_MANAGER'];
const ALL_ROLES = ['PRIME_MANAGER', 'GENERAL_MANAGER', 'LD_AGENT'];
const DEFAULT_AGENT_PERMS = { canCreate: true, canEdit: false, canDelete: false, canView: true };
const DEFAULT_MANAGER_PERMS = { canCreate: true, canEdit: true, canDelete: true, canView: true };

// Derive which entry type a user is allowed to handle:
//   PRIME_MANAGER  → 'PRIME'
//   GENERAL_MANAGER → 'GENERAL'
//   LD_AGENT        → inherits from their parent manager
const resolveAllowedType = async (user) => {
  if (user.role === 'PRIME_MANAGER') return 'PRIME';
  if (user.role === 'GENERAL_MANAGER') return 'GENERAL';
  if (user.role === 'LD_AGENT' && user.parent_id) {
    const { rows } = await pool.query(`SELECT role FROM ld_users WHERE id = $1 LIMIT 1`, [user.parent_id]);
    return rows[0]?.role === 'PRIME_MANAGER' ? 'PRIME' : 'GENERAL';
  }
  return null;
};

const sanitizeLdUser = (u) => {
  if (!u) return null;
  const { password, token_version, ...safe } = u;
  return safe;
};

const logActivity = async (client, { actorId, actorRole, action, entityType, entityId, meta }) => {
  try {
    await (client || pool).query(
      `INSERT INTO ld_activity_logs (actor_id, actor_role, action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId || null, actorRole || null, action, entityType || null, entityId || null, meta ? JSON.stringify(meta) : null],
    );
  } catch (e) {
    console.warn('[ldActivity] log failed:', e.message);
  }
};

// ==========================================================
// LD AUTH
// ==========================================================

export const ldLogin = asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  const { rows } = await pool.query(
    `SELECT * FROM ld_users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [String(username).trim()],
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });
  if (!user.is_active) return res.status(403).json({ success: false, message: 'Account disabled' });

  const valid = await compareLdPassword(password, user.password);
  if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });

  const version = user.token_version || 1;
  const allowedType = await resolveAllowedType(user);
  const payload = {
    id: user.id,
    role: user.role,
    parentId: user.parent_id,
    username: user.username,
    allowedType,
    version,
  };
  const accessToken = signLdAccessToken(payload);
  const refreshToken = signLdRefreshToken({ id: user.id, version });

  await pool.query(`UPDATE ld_users SET last_login_at = NOW() WHERE id = $1`, [user.id]);
  await logActivity(null, { actorId: user.id, actorRole: user.role, action: 'LD_LOGIN', entityType: 'ld_user', entityId: user.id });

  res.json({
    success: true,
    user: { ...sanitizeLdUser(user), allowedType },
    accessToken,
    refreshToken,
  });
});

export const ldRefresh = asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.get('x-refresh-token');
  if (!token) return res.status(401).json({ success: false, message: 'No refresh token' });

  let decoded;
  try { decoded = verifyLdRefreshToken(token); }
  catch { return res.status(401).json({ success: false, message: 'Invalid refresh token' }); }

  const { rows } = await pool.query(`SELECT * FROM ld_users WHERE id = $1 LIMIT 1`, [decoded.id]);
  const user = rows[0];
  if (!user || !user.is_active) return res.status(401).json({ success: false, message: 'Account inactive' });
  if (user.token_version !== decoded.version) return res.status(401).json({ success: false, message: 'Session expired' });

  const allowedType = await resolveAllowedType(user);
  const accessToken = signLdAccessToken({
    id: user.id, role: user.role, parentId: user.parent_id, username: user.username, allowedType, version: user.token_version,
  });
  res.json({ success: true, accessToken, user: { ...sanitizeLdUser(user), allowedType } });
});

export const ldMe = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM ld_users WHERE id = $1 LIMIT 1`, [req.ldUser.id]);
  // allowedType is already resolved by middleware from JWT
  res.json({ success: true, user: { ...sanitizeLdUser(rows[0]), allowedType: req.ldUser.allowedType } });
});

export const ldLogout = asyncHandler(async (req, res) => {
  // Bump token_version so any outstanding access tokens for this user stop working
  await pool.query(`UPDATE ld_users SET token_version = token_version + 1 WHERE id = $1`, [req.ldUser.id]);
  res.json({ success: true });
});

// ==========================================================
// ADMIN → LD USERS  (create managers + agents, permissions, block)
// ==========================================================

// Admin creates a manager (PRIME_MANAGER / GENERAL_MANAGER)
// Manager creates an agent (LD_AGENT)  — role is enforced via route-level auth.
export const createLdUser = asyncHandler(async (req, res) => {
  const { name, username, password, role, permissions, siteId } = req.body || {};

  if (!name || !username || !password || !role) {
    return res.status(400).json({ success: false, message: 'name, username, password, role required' });
  }
  if (!ALL_ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  }

  // Determine parent + creator context
  let parentId = null;
  let createdBy = null;
  let actorRole = null;

  if (req.user) {
    // Main admin flow
    if (!(req.user.role === 'ADMIN' || req.user.role === 'OWNER')) {
      return res.status(403).json({ success: false, message: 'Admins only' });
    }
    // Admin can create managers; optionally agents under a specified parent
    if (role === 'LD_AGENT') {
      parentId = req.body.parentId || null;
      if (!parentId) return res.status(400).json({ success: false, message: 'parentId required for LD_AGENT' });
    }
    createdBy = req.user.id;
    actorRole = req.user.role;
  } else if (req.ldUser) {
    // Manager creating agents
    if (!MANAGER_ROLES.includes(req.ldUser.role)) {
      return res.status(403).json({ success: false, message: 'Managers only' });
    }
    if (role !== 'LD_AGENT') {
      return res.status(403).json({ success: false, message: 'Managers can create agents only' });
    }
    parentId = req.ldUser.id;
    createdBy = null;
    actorRole = req.ldUser.role;
  } else {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  // username uniqueness
  const dup = await pool.query(`SELECT id FROM ld_users WHERE LOWER(username) = LOWER($1) LIMIT 1`, [username]);
  if (dup.rows[0]) return res.status(409).json({ success: false, message: 'Username already exists' });

  const hashed = await hashLdPassword(password);
  const perms = permissions && typeof permissions === 'object'
    ? permissions
    : (role === 'LD_AGENT' ? DEFAULT_AGENT_PERMS : DEFAULT_MANAGER_PERMS);

  const insert = await pool.query(
    `INSERT INTO ld_users (name, username, password, role, parent_id, site_id, permissions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [name, username, hashed, role, parentId, siteId || req.ldUser?.siteId || null, JSON.stringify(perms), createdBy],
  );

  await logActivity(null, {
    actorId: req.user?.id || req.ldUser?.id,
    actorRole,
    action: 'LD_USER_CREATED',
    entityType: 'ld_user',
    entityId: insert.rows[0].id,
    meta: { role },
  });

  res.status(201).json({ success: true, user: sanitizeLdUser(insert.rows[0]) });
});

export const listLdUsers = asyncHandler(async (req, res) => {
  const { role, search, page = 1, limit = 50 } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (p - 1) * l;

  const where = [];
  const params = [];
  let i = 1;

  if (req.ldUser && MANAGER_ROLES.includes(req.ldUser.role)) {
    where.push(`parent_id = $${i++}`);
    params.push(req.ldUser.id);
    where.push(`role = 'LD_AGENT'`);
  } else if (req.ldUser && req.ldUser.role === 'LD_AGENT') {
    // An agent listing users only ever sees themselves
    where.push(`id = $${i++}`);
    params.push(req.ldUser.id);
  }
  // Admin path: no scope restriction

  if (role) { where.push(`role = $${i++}`); params.push(role); }
  if (search) { where.push(`(name ILIKE $${i} OR username ILIKE $${i})`); params.push(`%${search}%`); i++; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countSql = `SELECT COUNT(*)::int AS total FROM ld_users ${whereSql}`;
  const dataSql = `SELECT id, name, username, role, parent_id, site_id, is_active, permissions, last_login_at, created_at
                   FROM ld_users ${whereSql}
                   ORDER BY created_at DESC
                   LIMIT ${l} OFFSET ${offset}`;

  const [countRes, dataRes] = await Promise.all([
    pool.query(countSql, params),
    pool.query(dataSql, params),
  ]);

  res.json({
    success: true,
    total: countRes.rows[0].total,
    page: p,
    limit: l,
    users: dataRes.rows,
  });
});

export const updateLdUserPermissions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { permissions } = req.body || {};
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ success: false, message: 'permissions object required' });
  }

  // Managers can only modify their own agents' permissions
  if (req.ldUser && MANAGER_ROLES.includes(req.ldUser.role)) {
    const own = await pool.query(`SELECT id FROM ld_users WHERE id = $1 AND parent_id = $2`, [id, req.ldUser.id]);
    if (!own.rows[0]) return res.status(403).json({ success: false, message: 'Not your agent' });
  }

  const upd = await pool.query(
    `UPDATE ld_users SET permissions = $1 WHERE id = $2 RETURNING *`,
    [JSON.stringify(permissions), id],
  );
  if (!upd.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });

  await logActivity(null, {
    actorId: req.user?.id || req.ldUser?.id,
    actorRole: req.user?.role || req.ldUser?.role,
    action: 'LD_USER_PERMISSIONS_UPDATED',
    entityType: 'ld_user',
    entityId: id,
    meta: { permissions },
  });
  res.json({ success: true, user: sanitizeLdUser(upd.rows[0]) });
});

export const toggleLdUserBlock = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ success: false, message: 'isActive boolean required' });
  }

  // Managers can only block their own agents
  if (req.ldUser && MANAGER_ROLES.includes(req.ldUser.role)) {
    const own = await pool.query(`SELECT id FROM ld_users WHERE id = $1 AND parent_id = $2`, [id, req.ldUser.id]);
    if (!own.rows[0]) return res.status(403).json({ success: false, message: 'Not your agent' });
  }

  const upd = await pool.query(
    `UPDATE ld_users
       SET is_active = $1,
           token_version = CASE WHEN $1 = false THEN token_version + 1 ELSE token_version END
     WHERE id = $2 RETURNING *`,
    [isActive, id],
  );
  if (!upd.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });

  await logActivity(null, {
    actorId: req.user?.id || req.ldUser?.id,
    actorRole: req.user?.role || req.ldUser?.role,
    action: isActive ? 'LD_USER_UNBLOCKED' : 'LD_USER_BLOCKED',
    entityType: 'ld_user',
    entityId: id,
  });
  res.json({ success: true, user: sanitizeLdUser(upd.rows[0]) });
});

export const resetLdUserPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ success: false, message: 'Password min 6 chars' });
  }

  if (req.ldUser && MANAGER_ROLES.includes(req.ldUser.role)) {
    const own = await pool.query(`SELECT id FROM ld_users WHERE id = $1 AND parent_id = $2`, [id, req.ldUser.id]);
    if (!own.rows[0]) return res.status(403).json({ success: false, message: 'Not your agent' });
  }

  const hashed = await hashLdPassword(password);
  const upd = await pool.query(
    `UPDATE ld_users SET password = $1, token_version = token_version + 1 WHERE id = $2 RETURNING *`,
    [hashed, id],
  );
  if (!upd.rows[0]) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user: sanitizeLdUser(upd.rows[0]) });
});

// ==========================================================
// EVENTS
// ==========================================================

export const createEvent = asyncHandler(async (req, res) => {
  const { eventName, description, siteId, status } = req.body || {};
  if (!eventName) return res.status(400).json({ success: false, message: 'eventName required' });

  const { rows } = await pool.query(
    `INSERT INTO ld_events (event_name, description, site_id, status, created_by)
     VALUES ($1, $2, $3, COALESCE($4, 'ACTIVE'), $5)
     RETURNING *`,
    [eventName, description || null, siteId || null, status || null, req.user?.id || null],
  );

  await logActivity(null, {
    actorId: req.user?.id || req.ldUser?.id,
    actorRole: req.user?.role || req.ldUser?.role,
    action: 'LD_EVENT_CREATED',
    entityType: 'ld_event',
    entityId: rows[0].id,
  });
  res.status(201).json({ success: true, event: rows[0] });
});

export const listEvents = asyncHandler(async (req, res) => {
  const { status, search } = req.query;
  const where = [];
  const params = [];
  let i = 1;
  if (status) { where.push(`status = $${i++}`); params.push(status); }
  if (search) { where.push(`event_name ILIKE $${i++}`); params.push(`%${search}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT e.*,
            COALESCE((SELECT COUNT(*) FROM ld_entries WHERE event_id = e.id), 0)::int AS entry_count,
            COALESCE((SELECT COUNT(*) FROM ld_entries WHERE event_id = e.id AND type='PRIME'), 0)::int AS prime_count,
            COALESCE((SELECT COUNT(*) FROM ld_entries WHERE event_id = e.id AND type='GENERAL'), 0)::int AS general_count
       FROM ld_events e ${whereSql}
      ORDER BY created_at DESC`,
    params,
  );
  res.json({ success: true, events: rows });
});

export const getEvent = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM ld_events WHERE id = $1 LIMIT 1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found' });
  res.json({ success: true, event: rows[0] });
});

export const updateEventStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['ACTIVE', 'CLOSED', 'DRAFT'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  const { rows } = await pool.query(
    `UPDATE ld_events SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id],
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Event not found' });
  res.json({ success: true, event: rows[0] });
});

export const deleteEvent = asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM ld_events WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Event not found' });
  res.json({ success: true });
});

// ==========================================================
// ENTRIES  (agents create, everyone reads scoped data)
// ==========================================================

// Build a data-scope WHERE clause + params based on current actor.
// Automatically restricts by entry type based on the actor's allowedType.
const buildEntryScope = (req, startIndex = 1) => {
  const where = [];
  const params = [];
  let i = startIndex;

  if (req.user) {
    // admin: no scope restriction (sees all types)
  } else if (req.ldUser?.role === 'LD_AGENT') {
    where.push(`e.created_by = $${i++}`);
    params.push(req.ldUser.id);
  } else if (req.ldUser && MANAGER_ROLES.includes(req.ldUser.role)) {
    where.push(`e.manager_id = $${i++}`);
    params.push(req.ldUser.id);
  } else {
    where.push(`1 = 0`); // deny
  }

  // Enforce type isolation: non-admin actors only see their allowed type
  if (!req.user && req.ldUser?.allowedType) {
    where.push(`e.type = $${i++}`);
    params.push(req.ldUser.allowedType);
  }

  return { where, params, next: i };
};

export const createEntry = asyncHandler(async (req, res) => {
  const { eventId, type, name, phone, altPhone, team, address } = req.body || {};
  if (!eventId || !type || !name || !phone) {
    return res.status(400).json({ success: false, message: 'eventId, type, name, phone required' });
  }
  if (!['PRIME', 'GENERAL'].includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid type' });
  }
  if (!req.ldUser) return res.status(403).json({ success: false, message: 'Agents only' });

  // Enforce type isolation
  if (req.ldUser.allowedType && type !== req.ldUser.allowedType) {
    return res.status(403).json({
      success: false,
      message: `You can only create ${req.ldUser.allowedType} entries`,
    });
  }

  // Managers can also create entries (they act as agents if needed)
  const createdBy = req.ldUser.id;
  const managerId = req.ldUser.role === 'LD_AGENT' ? req.ldUser.parentId : req.ldUser.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock event row + verify + bump serial counter atomically
    const ev = await client.query(
      `SELECT id, status, serial_counter, site_id FROM ld_events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    if (!ev.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    if (ev.rows[0].status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Event not active' });
    }

    const nextSerial = (ev.rows[0].serial_counter || 0) + 1;
    await client.query(`UPDATE ld_events SET serial_counter = $1 WHERE id = $2`, [nextSerial, eventId]);

    const entryInsert = await client.query(
      `INSERT INTO ld_entries
         (event_id, type, created_by, manager_id, name, phone, alt_phone, team, address, site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [eventId, type, createdBy, managerId, name, phone, altPhone || null, team || null, address || null, ev.rows[0].site_id],
    );
    const entry = entryInsert.rows[0];

    const receiptInsert = await client.query(
      `INSERT INTO ld_receipts (entry_id, event_id, serial_number)
       VALUES ($1, $2, $3) RETURNING *`,
      [entry.id, eventId, nextSerial],
    );

    await client.query('COMMIT');
    await logActivity(null, {
      actorId: createdBy,
      actorRole: req.ldUser.role,
      action: 'LD_ENTRY_CREATED',
      entityType: 'ld_entry',
      entityId: entry.id,
      meta: { type, serial: nextSerial },
    });

    res.status(201).json({ success: true, entry, receipt: receiptInsert.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /entries/my — entries visible to actor, with filters
export const listMyEntries = asyncHandler(async (req, res) => {
  const { type, search, eventId, page = 1, limit = 20 } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (p - 1) * l;

  const { where, params, next } = buildEntryScope(req, 1);
  let i = next;
  if (type) { where.push(`e.type = $${i++}`); params.push(type); }
  if (eventId) { where.push(`e.event_id = $${i++}`); params.push(eventId); }
  if (search) { where.push(`(e.name ILIKE $${i} OR e.phone ILIKE $${i})`); params.push(`%${search}%`); i++; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [countRes, dataRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM ld_entries e ${whereSql}`, params),
    pool.query(
      `SELECT e.*,
              r.serial_number,
              ev.event_name,
              u.name AS agent_name
         FROM ld_entries e
         LEFT JOIN ld_receipts r ON r.entry_id = e.id
         LEFT JOIN ld_events ev ON ev.id = e.event_id
         LEFT JOIN ld_users u ON u.id = e.created_by
        ${whereSql}
        ORDER BY e.created_at DESC
        LIMIT ${l} OFFSET ${offset}`,
      params,
    ),
  ]);

  res.json({
    success: true,
    total: countRes.rows[0].total,
    page: p,
    limit: l,
    entries: dataRes.rows,
  });
});

// GET /entries/event/:id — entries for an event, scoped
export const listEntriesForEvent = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { type, search, page = 1, limit = 50 } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const offset = (p - 1) * l;

  const { where, params, next } = buildEntryScope(req, 2);
  let i = next;
  where.unshift(`e.event_id = $1`);
  params.unshift(id);
  if (type) { where.push(`e.type = $${i++}`); params.push(type); }
  if (search) { where.push(`(e.name ILIKE $${i} OR e.phone ILIKE $${i})`); params.push(`%${search}%`); i++; }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [countRes, dataRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM ld_entries e ${whereSql}`, params),
    pool.query(
      `SELECT e.*, r.serial_number, u.name AS agent_name
         FROM ld_entries e
         LEFT JOIN ld_receipts r ON r.entry_id = e.id
         LEFT JOIN ld_users u ON u.id = e.created_by
        ${whereSql}
        ORDER BY r.serial_number ASC NULLS LAST
        LIMIT ${l} OFFSET ${offset}`,
      params,
    ),
  ]);
  res.json({
    success: true,
    total: countRes.rows[0].total,
    page: p,
    limit: l,
    entries: dataRes.rows,
  });
});

const assertCanAccessEntry = async (req, entryId) => {
  if (req.user) return true; // admin
  const { rows } = await pool.query(`SELECT created_by, manager_id FROM ld_entries WHERE id = $1`, [entryId]);
  if (!rows[0]) return false;
  if (req.ldUser.role === 'LD_AGENT') return String(rows[0].created_by) === String(req.ldUser.id);
  if (MANAGER_ROLES.includes(req.ldUser.role)) return String(rows[0].manager_id) === String(req.ldUser.id);
  return false;
};

export const updateEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ok = await assertCanAccessEntry(req, id);
  if (!ok) return res.status(403).json({ success: false, message: 'Forbidden' });

  const perms = req.ldUser?.permissions || {};
  if (req.ldUser && req.ldUser.role === 'LD_AGENT' && perms.canEdit !== true) {
    return res.status(403).json({ success: false, message: 'Missing permission: canEdit' });
  }

  const { name, phone, altPhone, team, address, type } = req.body || {};
  const fields = [];
  const params = [];
  let i = 1;
  if (name !== undefined)     { fields.push(`name = $${i++}`); params.push(name); }
  if (phone !== undefined)    { fields.push(`phone = $${i++}`); params.push(phone); }
  if (altPhone !== undefined) { fields.push(`alt_phone = $${i++}`); params.push(altPhone); }
  if (team !== undefined)     { fields.push(`team = $${i++}`); params.push(team); }
  if (address !== undefined)  { fields.push(`address = $${i++}`); params.push(address); }
  if (type !== undefined) {
    if (!['PRIME', 'GENERAL'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid type' });
    // Prevent changing the type to one this actor isn't allowed to manage
    if (req.ldUser?.allowedType && type !== req.ldUser.allowedType) {
      return res.status(403).json({ success: false, message: `You can only manage ${req.ldUser.allowedType} entries` });
    }
    fields.push(`type = $${i++}`); params.push(type);
  }
  if (!fields.length) return res.status(400).json({ success: false, message: 'No fields to update' });
  params.push(id);

  const { rows } = await pool.query(
    `UPDATE ld_entries SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params,
  );
  res.json({ success: true, entry: rows[0] });
});

export const deleteEntry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const ok = await assertCanAccessEntry(req, id);
  if (!ok) return res.status(403).json({ success: false, message: 'Forbidden' });

  const perms = req.ldUser?.permissions || {};
  if (req.ldUser && req.ldUser.role === 'LD_AGENT' && perms.canDelete !== true) {
    return res.status(403).json({ success: false, message: 'Missing permission: canDelete' });
  }

  await pool.query(`DELETE FROM ld_entries WHERE id = $1`, [id]);
  res.json({ success: true });
});

// ==========================================================
// RECEIPT  (scoped access; returns all fields needed to print)
// ==========================================================
export const getReceipt = asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const ok = await assertCanAccessEntry(req, entryId);
  if (!ok) return res.status(403).json({ success: false, message: 'Forbidden' });

  const { rows } = await pool.query(
    `SELECT
        e.id AS entry_id,
        e.name, e.phone, e.alt_phone, e.team, e.address, e.type, e.created_at,
        r.serial_number,
        ev.id AS event_id, ev.event_name,
        s.name AS site_name
       FROM ld_entries e
  LEFT JOIN ld_receipts r ON r.entry_id = e.id
  LEFT JOIN ld_events ev ON ev.id = e.event_id
  LEFT JOIN sites s ON s.id = e.site_id
      WHERE e.id = $1
      LIMIT 1`,
    [entryId],
  );
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Entry not found' });
  res.json({ success: true, receipt: rows[0] });
});

// ==========================================================
// DASHBOARD / STATS
// ==========================================================
export const ldDashboardStats = asyncHandler(async (req, res) => {
  const { where, params } = buildEntryScope(req, 1);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totals, byType, byEvent, recent] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM ld_entries e ${whereSql}`, params),
    pool.query(
      `SELECT e.type, COUNT(*)::int AS count
         FROM ld_entries e ${whereSql}
        GROUP BY e.type`,
      params,
    ),
    pool.query(
      `SELECT ev.id, ev.event_name, COUNT(e.id)::int AS count
         FROM ld_entries e
    LEFT JOIN ld_events ev ON ev.id = e.event_id
         ${whereSql}
        GROUP BY ev.id, ev.event_name
        ORDER BY count DESC
        LIMIT 10`,
      params,
    ),
    pool.query(
      `SELECT e.id, e.name, e.type, e.created_at, r.serial_number, ev.event_name
         FROM ld_entries e
    LEFT JOIN ld_receipts r ON r.entry_id = e.id
    LEFT JOIN ld_events ev ON ev.id = e.event_id
         ${whereSql}
        ORDER BY e.created_at DESC
        LIMIT 10`,
      params,
    ),
  ]);

  const typeMap = Object.fromEntries(byType.rows.map((r) => [r.type, r.count]));
  res.json({
    success: true,
    stats: {
      total: totals.rows[0].total,
      prime: typeMap.PRIME || 0,
      general: typeMap.GENERAL || 0,
      byEvent: byEvent.rows,
      recent: recent.rows,
    },
  });
});

// ==========================================================
// ACTIVITY LOGS (admin-only)
// ==========================================================
export const listActivityLogs = asyncHandler(async (req, res) => {
  const { limit = 100 } = req.query;
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
  const { rows } = await pool.query(
    `SELECT * FROM ld_activity_logs ORDER BY created_at DESC LIMIT $1`,
    [l],
  );
  res.json({ success: true, logs: rows });
});
