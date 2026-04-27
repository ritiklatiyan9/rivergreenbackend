// Roll back the 9 bookings I moved into Defence Garden Phase 2 — they were
// originally River Green Colony bookings (all created before the DG2 map
// existed). Returns each booking + its plot back to River Green Colony.
//
// Idempotent: only touches the 9 known booking IDs from the previous move.

import 'dotenv/config';
import pool from '../src/config/db.js';

const BOOKING_IDS = [
  'c4c12d5a-e6cb-49c1-8a07-2ee576e6cec9', // C-12 Arjun Baliyan
  '46842127-b32c-47be-83b3-fba845f72631', // C-13 Ritik Kumar
  '4e1823a8-39f0-47de-a397-f0ea74a22140', // C-14 Ritik Kumar
  '86aa2680-187a-4db6-b858-7807f690eb59', // A-53 Ritik Kumar
  '4ae2738a-fad3-433e-81f0-b4139825480f', // C-15 Anubhav Tyagi
  'a0f71862-e297-441d-bebd-6728d31a4231', // C-16 Arjun Singh
  'f1fc9158-d8ef-402c-b4cf-2ce1b97dcd0c', // C-17 Ritik Kumar
  'e16659db-e94e-4205-b256-bac582a62e0e', // C-18 Golu
  '3c0ed46e-b04b-4a3b-bebd-748c0e8e53a9', // C-19 prakhar gupta
];

(async () => {
  const client = await pool.connect();
  try {
    const sites = await client.query('SELECT id FROM sites ORDER BY created_at LIMIT 1');
    const siteId = sites.rows[0].id;

    const cm = await client.query(
      "SELECT id, name FROM colony_maps WHERE site_id = $1 AND name IN ('River Green Colony', 'Defence Garden Phase 2')",
      [siteId]
    );
    const rg = cm.rows.find(c => c.name === 'River Green Colony');
    const dg2 = cm.rows.find(c => c.name === 'Defence Garden Phase 2');
    if (!rg || !dg2) { console.log('Missing colony reference.'); return; }

    console.log(`River Green Colony   : ${rg.id}`);
    console.log(`Defence Garden Phase2: ${dg2.id}\n`);

    await client.query('BEGIN');
    let moved = 0;
    for (const id of BOOKING_IDS) {
      const r = await client.query(
        `SELECT pb.id AS booking_id, pb.plot_id, pb.colony_map_id, mp.colony_map_id AS plot_colony, mp.plot_number
         FROM plot_bookings pb JOIN map_plots mp ON pb.plot_id = mp.id
         WHERE pb.id = $1`,
        [id]
      );
      if (r.rows.length === 0) {
        console.log(`  ⚠ ${id} not found, skipping`);
        continue;
      }
      const row = r.rows[0];
      if (row.colony_map_id !== dg2.id && row.plot_colony !== dg2.id) {
        console.log(`  ↷ ${row.plot_number} (${row.booking_id}) already not in DG2, skipping`);
        continue;
      }
      await client.query('UPDATE map_plots SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [rg.id, row.plot_id]);
      await client.query('UPDATE plot_bookings SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [rg.id, row.booking_id]);
      console.log(`  ✓ ${row.plot_number} (${row.booking_id}) → River Green Colony`);
      moved++;
    }
    await client.query('COMMIT');

    const sumRes = await client.query(
      `SELECT cm.name, COUNT(pb.id) AS bookings
       FROM colony_maps cm LEFT JOIN plot_bookings pb ON pb.colony_map_id = cm.id
       WHERE cm.site_id = $1 GROUP BY cm.id, cm.name ORDER BY cm.created_at`,
      [siteId]
    );
    console.log(`\n✓ Rolled back ${moved} booking(s).\n\nFinal counts:`);
    sumRes.rows.forEach(r => console.log(`  ${r.name}: ${r.bookings}`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rollback failed (transaction reverted):', err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
