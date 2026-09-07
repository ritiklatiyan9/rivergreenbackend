// Run against the deployment's configured database before deploying this code.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
try {
  const sql = await readFile(new URL('../src/migrations/zz_attendance_hr_integration.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Attendance / HR integration migration completed.');
} catch (error) {
  console.error('Attendance / HR migration failed:', error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
