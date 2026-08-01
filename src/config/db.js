import pkg from 'pg';
const { Pool } = pkg;

const toBoundedInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
};

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const dbHost = process.env.DB_HOST;
const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '';

// The app operates in IST. Neon (and most cloud Postgres) default the session
// timezone to UTC, which makes CURRENT_DATE / NOW() / `timestamptz::date` /
// DATE_TRUNC resolve ~5.5h early — so "today's" calls, due-today followups,
// attendance, etc. land on the wrong calendar day. Pin every connection to the
// timezone the queries were written for so date boundaries match the user's day.
const requestedTimeZone = process.env.DB_TIMEZONE || 'Asia/Kolkata';
const appTimeZone = /^[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)*$/.test(requestedTimeZone)
  ? requestedTimeZone
  : 'Asia/Kolkata';

const poolMax = toBoundedInt(process.env.DB_POOL_MAX, 15, 2, 50);
const connectionTimeoutMillis = toBoundedInt(process.env.DB_CONNECT_TIMEOUT_MS, 5_000, 1_000, 30_000);
const statementTimeoutMillis = toBoundedInt(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000, 5_000, 120_000);

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: sslOption,
  max: poolMax,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis,
  statement_timeout: statementTimeoutMillis,
  query_timeout: statementTimeoutMillis + 1_000,
  idle_in_transaction_session_timeout: 15_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: process.env.DB_APPLICATION_NAME || 'rivergreen-backend',
  allowExitOnIdle: false,
  options: `-c timezone=${appTimeZone}`,
});

// Belt-and-suspenders: also set it per connection in case the startup `options`
// param is stripped by a connection pooler (Neon's pooled endpoint).
pool.on('connect', (client) => {
  client.query("SELECT set_config('timezone', $1, false)", [appTimeZone]).catch((err) => {
    console.error('[pg-pool] Failed to set session timezone:', err.message);
  });
});

// Neon (and other serverless DBs) silently terminate idle connections.
// Without this handler the unhandled 'error' event on the pool crashes Node.
pool.on('error', (err, client) => {
  console.error('[pg-pool] Idle client error — connection was terminated by server:', err.message);
  // Do NOT re-throw — let the pool remove and replace the dead client automatically.
});

export const connectDB = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('Database connection error', err);
    throw err;
  }
};

export const closeDB = () => pool.end();

export default pool;
