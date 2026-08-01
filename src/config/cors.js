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
 * must be listed explicitly in CORS_ORIGINS in production (comma separated).
 * Requests without an Origin header are allowed for Android/native, health
 * checks, cron jobs, and trusted server-to-server callers.
 */
export const isOriginAllowed = (origin) => {
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  return (process.env.NODE_ENV !== 'production' && configuredOrigins.has('*'))
    || configuredOrigins.has(normalized)
    || nativeAppOrigins.has(normalized)
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
