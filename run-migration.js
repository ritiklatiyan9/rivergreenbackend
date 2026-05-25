// One-shot migration runner — run with: node run-migration.js <path-to-sql>
// Example: node run-migration.js src/migrations/sub_agent.sql

import { config } from 'dotenv';
config();

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pkg from 'pg';

const { Pool } = pkg;

const sslOption =
  process.env.DB_SSL === 'true' ||
  (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
    ? { rejectUnauthorized: false }
    : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '',
  ssl: sslOption,
});

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node run-migration.js <path-to-sql>');
  process.exit(1);
}

const sql = readFileSync(resolve(sqlFile), 'utf8');

(async () => {
  const client = await pool.connect();
  try {
    console.log(`Running migration: ${sqlFile}`);
    await client.query(sql);
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
