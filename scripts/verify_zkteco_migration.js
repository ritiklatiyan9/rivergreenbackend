import 'dotenv/config';
import pool from '../src/config/db.js';

(async () => {
  try {
    const checks = [
      { label: 'attendance_locations.zkteco_enabled', sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_locations' AND column_name='zkteco_enabled'` },
      { label: 'attendance_locations.zkteco_ip',      sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_locations' AND column_name='zkteco_ip'` },
      { label: 'attendance_locations.zkteco_last_log_id', sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_locations' AND column_name='zkteco_last_log_id'` },
      { label: 'attendance_locations.site_id',        sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_locations' AND column_name='site_id'` },
      { label: 'users.zkteco_user_id',                sql: `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='zkteco_user_id'` },
      { label: 'users.primary_attendance_location_id', sql: `SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='primary_attendance_location_id'` },
      { label: 'attendance_records.source',           sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_records' AND column_name='source'` },
      { label: 'attendance_records.is_secondary',     sql: `SELECT 1 FROM information_schema.columns WHERE table_name='attendance_records' AND column_name='is_secondary'` },
      { label: 'zkteco_unmapped_punches table',       sql: `SELECT 1 FROM information_schema.tables WHERE table_name='zkteco_unmapped_punches'` },
    ];
    let pass = 0, fail = 0;
    for (const c of checks) {
      const r = await pool.query(c.sql);
      if (r.rowCount > 0) { console.log(`  ok  ${c.label}`); pass++; }
      else                { console.log(`  FAIL ${c.label}`); fail++; }
    }
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exitCode = fail === 0 ? 0 : 2;
  } catch (err) {
    console.error('Verify failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
