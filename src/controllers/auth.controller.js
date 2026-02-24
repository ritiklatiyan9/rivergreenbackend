import asyncHandler from '../utils/asyncHandler.js';
import { signAccessToken, signRefreshToken, verifyToken, hashPassword, comparePassword, hashRefreshToken } from '../config/jwt.js';
import userModel from '../models/User.model.js';
import pool from '../config/db.js';

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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

  const user = await userModel.findById(decoded.id, pool);
  if (!user || user.token_version !== decoded.version) {
    if (user) await userModel.update(user.id, { token_version: (user.token_version || 0) + 1, refresh_token: null }, pool);
    res.clearCookie('refreshToken', { path: '/' });
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
  }

  const valid = await comparePassword(refreshToken, user.refresh_token);
  if (!valid) {
    await userModel.update(user.id, { token_version: (user.token_version || 0) + 1, refresh_token: null }, pool);
    res.clearCookie('refreshToken', { path: '/' });
    return res.status(401).json({ success: false, message: 'Invalid refresh token' });
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

  res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);
  res.json({ success: true, accessToken });
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