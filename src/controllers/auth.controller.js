import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import siteModel from '../models/Site.model.js';
import pool from '../config/db.js';
import { uploadSingle } from '../utils/upload.js';
import { ensureUserSiteAccessTable, getUserAssignedSiteIds } from '../utils/userSiteAccess.js';
import fcmService from '../services/fcm.service.js';
import { bustCache } from '../middlewares/cache.middleware.js';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

// clearCookie must use the same flags (minus maxAge) to actually remove the cookie
const CLEAR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  path: '/',
};

const sanitizeUser = (user) => {
  const { password, refresh_token, token_version, ...safe } = user;
  return safe;
};

const readRefreshToken = (req) => {
  const headerToken = req.get('x-refresh-token');
  return req.cookies?.refreshToken || req.body?.refreshToken || headerToken || null;
};

const getAccessibleSitesForUser = async (user) => {
  if (!user) return [];

  if (user.role === 'OWNER' || user.role === 'ADMIN') {
    const sites = await siteModel.findAll(pool);
    return sites.filter((site) => site.is_active !== false);
  }

  // Supervisor: pull from supervisor_site_access table
  if (user.role === 'SUPERVISOR') {
    const ssaResult = await pool.query(
      'SELECT site_id FROM supervisor_site_access WHERE supervisor_id = $1',
      [user.id],
    );
    const siteIds = ssaResult.rows.map((r) => String(r.site_id));
    // Include primary site_id as fallback
    if (user.site_id && !siteIds.includes(String(user.site_id))) {
      siteIds.unshift(String(user.site_id));
    }
    if (!siteIds.length) return [];

    const sitesResult = await pool.query(
      'SELECT * FROM sites WHERE id = ANY($1::uuid[]) AND is_active = true',
      [siteIds],
    );
    const siteById = new Map(sitesResult.rows.map((site) => [String(site.id), site]));
    return siteIds.map((id) => siteById.get(id)).filter(Boolean);
  }

  await ensureUserSiteAccessTable(pool);
  const assignedSiteIds = await getUserAssignedSiteIds(user.id, pool, { includePrimary: true });
  if (!assignedSiteIds.length) return [];

  const sitesResult = await pool.query(
    'SELECT * FROM sites WHERE id = ANY($1::uuid[]) AND is_active = true',
    [assignedSiteIds],
  );

  const siteById = new Map(sitesResult.rows.map((site) => [String(site.id), site]));
  return assignedSiteIds
    .map((siteId) => siteById.get(String(siteId)))
    .filter(Boolean);
};

// Register owner via Postman
export const registerOwner = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Name, email and password are required' });
  }

  const existing = await userModel.findByEmail(email, pool);
  if (existing) return res.status(400).json({ success: false, message: 'Email already exists' });

  const sponsorCode = await userModel.getUniqueSponsorCode(pool);
  const hashedPassword = await hashPassword(password);
  const userData = { name, email, password: hashedPassword, role: 'OWNER', sponsor_code: sponsorCode, token_version: 1 };
  const user = await userModel.create(userData, pool);

  res.status(201).json({ success: true, user: sanitizeUser(user) });
});

// Login
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  const user = await userModel.findByEmail(email, pool);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(403).json({ success: false, message: 'Account is disabled. Contact administrator.' });
  }

  // Primary check: bcrypt compare (normal case)
  let valid = false;
  try {
    valid = await comparePassword(password, user.password);
  } catch (e) {
    valid = false;
  }

  // Fallback for legacy/plaintext-stored passwords: if the stored password
  // is the raw password (not hashed) allow login and transparently upgrade
  // the record to a bcrypt hash so subsequent logins work normally.
  if (!valid) {
    if (user.password && user.password === password) {
      // upgrade to hashed password
      const newHash = await hashPassword(password);
      await userModel.update(user.id, { password: newHash }, pool);
      valid = true;
    }
  }

  if (!valid) {
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  const newVersion = user.token_version || 1;
  if (!user.token_version) {
    await userModel.update(user.id, { token_version: newVersion }, pool);
  }

  const accessToken = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    site_id: user.site_id || null,
    version: newVersion,
  });
  const refreshToken = signRefreshToken({ id: user.id, version: newVersion });
  const hashedRefresh = await hashRefreshToken(refreshToken);
  await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);
  res.json({ success: true, user: sanitizeUser(user), accessToken, refreshToken });
});

// In-flight refresh lock per user — prevents token-version race when two
// refresh calls arrive in quick succession (e.g. interceptor retry + manual).
const _refreshLocks = new Map();

// Refresh Token
export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = readRefreshToken(req);
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: 'No refresh token' });
  }

  let decoded;
  try {
    decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }

  // Serialize concurrent refresh attempts for the same user
  if (_refreshLocks.has(decoded.id)) {
    try {
      const result = await _refreshLocks.get(decoded.id);
      // Second caller piggy-backs on the first caller's result
      res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTIONS);
      return res.json({ success: true, accessToken: result.accessToken, refreshToken: result.refreshToken });
    } catch {
      return res.status(401).json({ success: false, message: 'Refresh failed (concurrent)' });
    }
  }

  const work = (async () => {
    const user = await userModel.findById(decoded.id, pool);
    if (!user || user.token_version !== decoded.version) {
      console.warn(`[Auth] Version mismatch for user ${decoded.id}. Expected ${decoded.version}, found ${user?.token_version}`);
      res.clearCookie('refreshToken', CLEAR_COOKIE_OPTIONS);
      throw new Error('version_mismatch');
    }

    if (!user.is_active) {
      res.clearCookie('refreshToken', CLEAR_COOKIE_OPTIONS);
      throw new Error('inactive_user');
    }

    if (!user.refresh_token) {
      res.clearCookie('refreshToken', CLEAR_COOKIE_OPTIONS);
      throw new Error('missing_hash');
    }

    const valid = await comparePassword(refreshToken, user.refresh_token);
    if (!valid) {
      res.clearCookie('refreshToken', CLEAR_COOKIE_OPTIONS);
      throw new Error('invalid_hash');
    }

    // Keep token version stable during refresh so one stale/concurrent refresh
    // request does not invalidate all in-flight access tokens for this session.
    const currentVersion = user.token_version || 0;

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      site_id: user.site_id || null,
      version: currentVersion,
    });
    // Keep refresh token stable so active sessions are not invalidated by
    // refresh-token rotation races or out-of-order network responses.
    return { accessToken, refreshToken };
  })();

  _refreshLocks.set(decoded.id, work);

  try {
    const result = await work;
    res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTIONS);
    res.json({ success: true, accessToken: result.accessToken, refreshToken: result.refreshToken });
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  } finally {
    _refreshLocks.delete(decoded.id);
  }
});

// Logout
export const logout = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  await userModel.update(userId, { refresh_token: null }, pool);
  // Clear the FCM token for this device so the logged-out user stops
  // receiving pushes destined for the previous account on this phone.
  const token = req.body?.fcm_token;
  if (token) {
    try { await fcmService.deleteToken(token); } catch { /* non-fatal */ }
  }
  res.clearCookie('refreshToken', CLEAR_COOKIE_OPTIONS);
  res.json({ success: true, message: 'Logged out' });
});

// Register / refresh the FCM token for this device.
// Body: { token, platform? }
export const registerFcmToken = asyncHandler(async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'token is required' });
  }
  await fcmService.upsertToken(req.user.id, token, platform || 'android');
  res.json({ success: true });
});

// Remove a specific FCM token (used on logout from the device).
// Body: { token }
export const removeFcmToken = asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'token is required' });
  await fcmService.deleteToken(token);
  res.json({ success: true });
});

// One-off diagnostic: send a test push to the currently-authenticated user's
// registered devices. Logs the full FCM response so Render logs show exactly
// what Firebase said. Body: { title?, body? }
export const sendTestPush = asyncHandler(async (req, res) => {
  const title = req.body?.title || 'Test notification';
  const body = req.body?.body || 'If you see this, FCM is wired up end-to-end.';
  const result = await fcmService.sendToUsers([req.user.id], {
    title,
    body,
    data: { type: 'test', route: '/dashboard' },
  });
  console.log(`[fcm-test] user=${req.user.id.slice(0,8)} result=${JSON.stringify(result)}`);
  res.json({ success: true, result });
});

// Get current user profile
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findByIdSafe(req.user.id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

// Get all sites accessible to current user and resolve active site
export const getAccessibleSites = asyncHandler(async (req, res) => {
  const user = await userModel.findByIdSafe(req.user.id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const sites = await getAccessibleSitesForUser(user);
  const activeSite = user.site_id
    ? sites.find((site) => String(site.id) === String(user.site_id)) || null
    : sites[0] || null;

  res.json({
    success: true,
    sites,
    active_site_id: activeSite?.id || null,
    active_site: activeSite || null,
  });
});

// Set active site for current session user (persists on users.site_id)
export const setActiveSite = asyncHandler(async (req, res) => {
  const { site_id } = req.body;
  if (!site_id) {
    return res.status(400).json({ success: false, message: 'site_id is required' });
  }

  const user = await userModel.findById(req.user.id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const accessibleSites = await getAccessibleSitesForUser(user);
  const nextSite = accessibleSites.find((site) => String(site.id) === String(site_id));
  if (!nextSite) {
    return res.status(403).json({ success: false, message: 'You do not have access to this site' });
  }

  const updatedUser = await userModel.update(user.id, { site_id: nextSite.id }, pool);

  const accessToken = signAccessToken({
    id: updatedUser.id,
    email: updatedUser.email,
    role: updatedUser.role,
    site_id: nextSite.id,
    version: updatedUser.token_version,
  });

  // Bust every cached response keyed to this user — entries for either the
  // old site (now stale) or the new site (possibly poisoned by older buggy
  // controllers that ignored x-site-id) are both wiped. Fire-and-forget; the
  // response is independent.
  bustCache(`cache:${user.id}:*`).catch(() => {});

  res.json({
    success: true,
    message: 'Active site updated',
    accessToken,
    site_id: nextSite.id,
    site: nextSite,
  });
});

// Update own profile
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, phone, address, designation, bio, currentPassword, newPassword } = req.body;
  const userId = req.user.id;
  const user = await userModel.findById(userId, pool);

  let updateData = {};
  if (name) updateData.name = name;
  if (phone !== undefined) updateData.phone = phone;
  if (address !== undefined) updateData.address = address;
  if (designation !== undefined) updateData.designation = designation;
  if (bio !== undefined) updateData.bio = bio;

  if (email) {
    const existing = await userModel.findByEmail(email, pool);
    if (existing && existing.id !== userId) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    updateData.email = email;
  }

  // Handle profile photo upload via multer
  if (req.file) {
    try {
      const result = await uploadSingle(req.file, 's3');
      updateData.profile_photo = result.secure_url;
    } catch (err) {
      console.error('Profile photo upload error:', err);
      return res.status(500).json({ success: false, message: 'Failed to upload profile photo' });
    }
  }

  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ success: false, message: 'Current password is required' });
    }
    const validPass = await comparePassword(currentPassword, user.password);
    if (!validPass) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }
    updateData.password = await hashPassword(newPassword);
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, message: 'No data to update' });
  }

  await userModel.update(userId, updateData, pool);
  const updatedUser = await userModel.findByIdSafe(userId, pool);
  res.json({ success: true, user: updatedUser });
});