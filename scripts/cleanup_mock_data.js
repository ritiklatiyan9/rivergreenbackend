// Strip mock-derived rows out of the production DB so the system can
// switch over to real K40 hardware with a clean slate.
//
// Targets:
//   • attendance_locations rows pointing at 127.0.0.1 / localhost
//     (these were created during mock testing)
//   • zkteco_unmapped_punches rows referring to those locations
//   • attendance_records rows referring to those locations
//
// Mapped-but-unwanted records (e.g. a real user mapped to the mock's
// fixture user-ids 1001-1005) are also flagged so the operator can
// reset the mapping.
//
// Dry-run by default. Pass `--confirm` to actually delete.
//   node scripts/cleanup_mock_data.js
//   node scripts/cleanup_mock_data.js --confirm

import 'dotenv/config';
import pool from '../src/config/db.js';

const CONFIRM = process.argv.includes('--confirm');

const MOCK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const FIXTURE_ZKTECO_IDS = [1001, 1002, 1003, 1004, 1005];

const tag = (s) => `\x1b[36m${s}\x1b[0m`;
const ok  = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

(async () => {
  try {
    console.log(`\n${tag('cleanup_mock_data')}  mode=${CONFIRM ? ok('LIVE') : warn('DRY-RUN')}\n`);

    // 1) Find mock locations
    const locsRes = await pool.query(
      `SELECT id, name, zkteco_ip, zkteco_port
       FROM attendance_locations
       WHERE zkteco_ip = ANY($1::text[])`,
      [MOCK_HOSTS],
    );
    const mockLocs = locsRes.rows;
    console.log(`mock attendance_locations:  ${mockLocs.length}`);
    for (const l of mockLocs) console.log(`  - id=${l.id} name=${l.name} ip=${l.zkteco_ip}:${l.zkteco_port}`);

    const mockLocIds = mockLocs.map((l) => l.id);

    // 2) Count records that would be removed
    const recCount = mockLocIds.length === 0 ? 0 : (await pool.query(
      `SELECT COUNT(*) FROM attendance_records WHERE location_id = ANY($1::int[])`,
      [mockLocIds],
    )).rows[0].count;

    const unmapCount = mockLocIds.length === 0 ? 0 : (await pool.query(
      `SELECT COUNT(*) FROM zkteco_unmapped_punches WHERE location_id = ANY($1::int[])`,
      [mockLocIds],
    )).rows[0].count;

    console.log(`attendance_records to delete: ${recCount}`);
    console.log(`zkteco_unmapped_punches to delete: ${unmapCount}`);

    // 3) Real users still mapped to fixture ZKTeco IDs (advisory only)
    const stale = await pool.query(
      `SELECT id, name, email, zkteco_user_id
       FROM users
       WHERE zkteco_user_id = ANY($1::int[])`,
      [FIXTURE_ZKTECO_IDS],
    );
    console.log(`users still mapped to fixture IDs (advisory): ${stale.rows.length}`);
    for (const u of stale.rows) console.log(`  - ${u.name} <${u.email}> → zkteco_user_id=${u.zkteco_user_id}`);

    if (!CONFIRM) {
      console.log(`\n${warn('DRY-RUN — nothing deleted.')} Re-run with --confirm to apply.\n`);
      process.exit(0);
    }

    // 4) Execute deletes inside a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (mockLocIds.length > 0) {
        const r1 = await client.query(
          `DELETE FROM attendance_records WHERE location_id = ANY($1::int[])`,
          [mockLocIds],
        );
        console.log(`deleted attendance_records: ${r1.rowCount}`);

        const r2 = await client.query(
          `DELETE FROM zkteco_unmapped_punches WHERE location_id = ANY($1::int[])`,
          [mockLocIds],
        );
        console.log(`deleted zkteco_unmapped_punches: ${r2.rowCount}`);

        const r3 = await client.query(
          `DELETE FROM attendance_locations WHERE id = ANY($1::int[])`,
          [mockLocIds],
        );
        console.log(`deleted attendance_locations: ${r3.rowCount}`);
      }

      // Clear stale fixture mappings on real users so the operator
      // can re-map to real device IDs without unique-index conflicts.
      if (stale.rows.length > 0) {
        const r4 = await client.query(
          `UPDATE users
           SET zkteco_user_id = NULL, updated_at = NOW()
           WHERE zkteco_user_id = ANY($1::int[])`,
          [FIXTURE_ZKTECO_IDS],
        );
        console.log(`unset zkteco_user_id on users: ${r4.rowCount}`);
      }

      await client.query('COMMIT');
      console.log(`\n${ok('cleanup complete.')}\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\n\x1b[31mFAILED — rolled back: ${err.message}\x1b[0m\n`);
      process.exitCode = 2;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
})();
