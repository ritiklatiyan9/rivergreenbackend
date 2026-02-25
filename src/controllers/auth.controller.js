import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,                       // required for sameSite:'none'
  sameSite: 'none',                   // allow cross-origin cookie (frontend ↔ backend on different hosts)
  maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 days
  path: '/',
};

const sanitizeUser = (user) => {
  const { password, refresh_token, token_version, ...safe } = user;
  return safe;
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

  const newVersion = (user.token_version || 0) + 1;
  await userModel.update(user.id, { token_version: newVersion }, pool);

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
  res.json({ success: true, user: sanitizeUser(user), accessToken });
});

// In-flight refresh lock per user — prevents token-version race when two
// refresh calls arrive in quick succession (e.g. interceptor retry + manual).
const _refreshLocks = new Map();

// Refresh Token
export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
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
      res.cookie('refreshToken', result.newRefreshToken, REFRESH_COOKIE_OPTIONS);
      return res.json({ success: true, accessToken: result.accessToken });
    } catch {
      return res.status(401).json({ success: false, message: 'Refresh failed (concurrent)' });
    }
  }

  const work = (async () => {
    const user = await userModel.findById(decoded.id, pool);
    if (!user || user.token_version !== decoded.version) {
      if (user) await userModel.update(user.id, { token_version: (user.token_version || 0) + 1, refresh_token: null }, pool);
      res.clearCookie('refreshToken', { path: '/' });
      throw new Error('version_mismatch');
    }

    const valid = await comparePassword(refreshToken, user.refresh_token);
    if (!valid) {
      await userModel.update(user.id, { token_version: (user.token_version || 0) + 1, refresh_token: null }, pool);
      res.clearCookie('refreshToken', { path: '/' });
      throw new Error('invalid_hash');
    }

    const newVersion = (user.token_version || 0) + 1;
    await userModel.update(user.id, { token_version: newVersion }, pool);

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
      site_id: user.site_id || null,
      version: newVersion,
    });
    const newRefreshToken = signRefreshToken({ id: user.id, version: newVersion });
    const hashedRefresh = await hashRefreshToken(newRefreshToken);
    await userModel.update(user.id, { refresh_token: hashedRefresh }, pool);

    return { accessToken, newRefreshToken };
  })();

  _refreshLocks.set(decoded.id, work);

  try {
    const result = await work;
    res.cookie('refreshToken', result.newRefreshToken, REFRESH_COOKIE_OPTIONS);
    res.json({ success: true, accessToken: result.accessToken });
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
  res.clearCookie('refreshToken', { path: '/' });
  res.json({ success: true, message: 'Logged out' });
});

// Get current user profile
export const getMe = asyncHandler(async (req, res) => {
  const user = await userModel.findByIdSafe(req.user.id, pool);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

// Update own profile
export const updateProfile = asyncHandler(async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body;
  const userId = req.user.id;
  const user = await userModel.findById(userId, pool);

  let updateData = {};
  if (name) updateData.name = name;
  if (email) {
    const existing = await userModel.findByEmail(email, pool);
    if (existing && existing.id !== userId) {
      return res.status(400).json({ success: false, message: 'Email already in use' });
    }
    updateData.email = email;
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

  const updatedUser = await userModel.update(userId, updateData, pool);
  res.json({ success: true, user: sanitizeUser(updatedUser) });
});