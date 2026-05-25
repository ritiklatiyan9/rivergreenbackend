import pkg from 'pg';
const { Pool } = pkg;

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
const appTimeZone = process.env.DB_TIMEZONE || 'Asia/Kolkata';

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: sslOption,
  max: 20,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  allowExitOnIdle: false,
  options: `-c timezone=${appTimeZone}`,
});

// Belt-and-suspenders: also set it per connection in case the startup `options`
// param is stripped by a connection pooler (Neon's pooled endpoint).
pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${appTimeZone}'`).catch((err) => {
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

export default pool;