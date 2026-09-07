const configuredOrigins = new Set(
  [
    process.env.CORS_ORIGINS,
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    process.env.APP_URL,
    process.env.WEB_ORIGIN,
  ]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
);

const nativeAppOrigins = new Set([
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
]);

// Local Vite clients also connect to the deployed production API.
const localWebOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
]);

const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/$/, '');

const isDevelopmentOrigin = (origin) => {
  if (process.env.NODE_ENV === 'production') return false;

  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
};

/**
 * Native Capacitor requests have a stable localhost origin. Browser clients
 * on Vite's local port 5173 are also allowed. Other browser clients must be
 * listed explicitly in CORS_ORIGINS in production (comma separated).
 * Requests without an Origin header are allowed for Android/native, health
 * checks, cron jobs, and trusted server-to-server callers.
 */
export const isOriginAllowed = (origin) => {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  return (process.env.NODE_ENV !== 'production' && configuredOrigins.has('*'))
    || configuredOrigins.has(normalized)
    || nativeAppOrigins.has(normalized)
    || localWebOrigins.has(normalized)
    || isDevelopmentOrigin(normalized);
};

export const corsOrigin = (origin, callback) => {
  callback(null, isOriginAllowed(origin));
};

export const corsOptions = {
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-refresh-token',
    'x-site-id',
    'x-request-id',
    'x-owner-registration-secret',
  ],
  exposedHeaders: ['x-request-id', 'x-cache'],
  maxAge: 600,
};

export default corsOptions;
