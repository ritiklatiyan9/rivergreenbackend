// Separate JWT config for Lucky Draw users — isolated from main auth.
// Uses distinct secrets so a stolen admin token cannot impersonate an LD user
// (and vice-versa). Tokens are short-lived; no refresh cookie flow.

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

const LD_ACCESS_SECRET =
  process.env.LD_JWT_ACCESS_SECRET ||
  (process.env.JWT_ACCESS_SECRET ? `${process.env.JWT_ACCESS_SECRET}::ld` : 'ld-dev-access-secret-change-me');

const LD_REFRESH_SECRET =
  process.env.LD_JWT_REFRESH_SECRET ||
  (process.env.JWT_REFRESH_SECRET ? `${process.env.JWT_REFRESH_SECRET}::ld` : 'ld-dev-refresh-secret-change-me');

const LD_ACCESS_EXPIRES_IN = process.env.LD_JWT_ACCESS_EXPIRES_IN || '12h';
const LD_REFRESH_EXPIRES_IN = process.env.LD_JWT_REFRESH_EXPIRES_IN || '30d';

export const signLdAccessToken = (payload) =>
  jwt.sign(payload, LD_ACCESS_SECRET, { expiresIn: LD_ACCESS_EXPIRES_IN });

export const signLdRefreshToken = (payload) =>
  jwt.sign(payload, LD_REFRESH_SECRET, { expiresIn: LD_REFRESH_EXPIRES_IN });

export const verifyLdAccessToken = (token) => jwt.verify(token, LD_ACCESS_SECRET);
export const verifyLdRefreshToken = (token) => jwt.verify(token, LD_REFRESH_SECRET);

export const hashLdPassword = (password) => bcrypt.hash(password, 10);
export const compareLdPassword = (password, hash) => bcrypt.compare(password, hash);
