import 'dotenv/config';
import pool from '../src/config/db.js';

(async () => {
  try {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='users' AND column_name IN ('primary_site_id','primary_attendance_location_id','zkteco_user_id')
       ORDER BY column_name`,
    );
    console.log('users columns present:', cols.rows.map(r => r.column_name));

    const idx = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='users' AND indexname LIKE 'uq_users_zkteco%'`,
    );
    console.log('zkteco unique indexes:', idx.rows.map(r => r.indexname));

    const sample = await pool.query(
      `SELECT id, name, primary_site_id, zkteco_user_id FROM users WHERE primary_site_id IS NOT NULL LIMIT 5`,
    );
    console.log('users with primary_site_id (sample):', sample.rows);

    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE primary_site_id IS NOT NULL) AS with_primary,
         COUNT(*) FILTER (WHERE zkteco_user_id IS NOT NULL) AS with_zkteco
       FROM users`,
    );
    console.log('totals:', totals.rows[0]);
  } catch (err) {
    console.error('Verify failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
