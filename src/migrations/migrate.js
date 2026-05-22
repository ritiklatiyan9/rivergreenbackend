/**
 * Run all SQL migration files in order.
 * Usage: node src/migrations/migrate.js
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pool from '../config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const sql = readFileSync(join(__dirname, file), 'utf8');
  console.log(`Running ${file}...`);
  try {
    await pool.query(sql);
    console.log(`  ✓ ${file}`);
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`);
  }
}

await pool.end();
console.log('Migrations complete.');
