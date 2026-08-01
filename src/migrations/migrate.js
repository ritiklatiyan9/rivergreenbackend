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
    if (sql.includes('-- migrate:split-statements')) {
      const statements = sql.split(';').map((statement) => statement.trim()).filter(Boolean);
      const errors = [];
      for (const statement of statements) {
        try {
          // CREATE INDEX CONCURRENTLY must be issued as its own command and
          // outside an explicit or implicit multi-command transaction.
          await pool.query(statement);
        } catch (error) {
          errors.push(error);
          console.error(`    statement failed: ${error.message}`);
        }
      }
      if (errors.length > 0) throw new Error(`${errors.length} statement(s) failed`);
    } else {
      await pool.query(sql);
    }
    console.log(`  ✓ ${file}`);
  } catch (err) {
    console.error(`  ✗ ${file}: ${err.message}`);
  }
}

await pool.end();
console.log('Migrations complete.');
