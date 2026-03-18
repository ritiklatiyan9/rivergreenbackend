import fs from 'fs/promises';
import path from 'path';
import pool from '../src/config/db.js';

(async () => {
  try {
    const migrationFile = process.argv[2] || process.env.MIGRATION_FILE || 'enhanced_payments_clients.sql';
    const sqlFile = path.join(process.cwd(), 'src', 'migrations', migrationFile);
    const sql = await fs.readFile(sqlFile, 'utf8');
    console.log('Running migration file:', sqlFile);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Migration applied successfully.');

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Migration failed (rolled back):', err.message || err);
      process.exitCode = 2;
    } finally {
      client.release();
      await pool.end();
    }
  } catch (err) {
    console.error('Error reading migration file or connecting to DB:', err.message || err);
    process.exitCode = 1;
  }
})();
