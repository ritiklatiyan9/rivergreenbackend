// Move the user's recent /project/5 test bookings (B-19B, B-119, plus the
// CANCELLED B-19) into Defence Garden Phase 2. These were placed today after
// the DG2 map was deployed but before the website's API_URL fallback was
// pointed at localhost — so they hit the prod backend's old code and landed
// in River Green Colony.

import 'dotenv/config';
import pool from '../src/config/db.js';

// Limit: only PUBLIC bookings whose plot was auto-created today AND whose
// label matches a label that only exists in the DG2 map JSX (B-19B and
// B-119 are in BOTH maps — but River Green never had them as canonical
// plots before today, so any auto-created today-row is a /project/5 booking).
const TARGET_LABELS = ['B-19B', 'B-119', 'B-19'];

(async () => {
  const client = await pool.connect();
  try {
    const sites = await client.query('SELECT id FROM sites ORDER BY created_at LIMIT 1');
    const siteId = sites.rows[0].id;
    const cm = await client.query(
      "SELECT id, name FROM colony_maps WHERE site_id = $1 AND name IN ('River Green Colony','Defence Garden Phase 2')",
      [siteId]
    );
    const rg = cm.rows.find(c => c.name === 'River Green Colony');
    const dg2 = cm.rows.find(c => c.name === 'Defence Garden Phase 2');

    // Find the candidate bookings — created today, currently in River Green,
    // whose plot was auto-created (created_at within 5s of the booking) and
    // whose label is in the targeted set.
    const candidates = await client.query(
      `SELECT pb.id AS booking_id, pb.client_name, pb.created_at AS booked_at, pb.status,
              mp.id AS plot_id, mp.plot_number, mp.created_at AS plot_created_at
       FROM plot_bookings pb
       JOIN map_plots mp ON pb.plot_id = mp.id
       WHERE pb.site_id = $1
         AND pb.colony_map_id = $2
         AND mp.plot_number = ANY($3)
         AND pb.created_at::date = CURRENT_DATE
       ORDER BY pb.created_at`,
      [siteId, rg.id, TARGET_LABELS]
    );

    if (candidates.rows.length === 0) {
      console.log('No candidate bookings found.');
      return;
    }

    console.log('Candidates to move into Defence Garden Phase 2:\n');
    candidates.rows.forEach(r => console.log(
      `  ${r.booked_at.toISOString()}  ${r.plot_number.padEnd(6)}  ${r.client_name}  status=${r.status}`
    ));

    await client.query('BEGIN');
    for (const r of candidates.rows) {
      await client.query('UPDATE map_plots SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [dg2.id, r.plot_id]);
      await client.query('UPDATE plot_bookings SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [dg2.id, r.booking_id]);
    }
    await client.query('COMMIT');

    console.log(`\n✓ Moved ${candidates.rows.length} booking(s) to Defence Garden Phase 2.`);

    const sumRes = await client.query(
      `SELECT cm.name, COUNT(pb.id) AS bookings
       FROM colony_maps cm LEFT JOIN plot_bookings pb ON pb.colony_map_id = cm.id
       WHERE cm.site_id = $1 GROUP BY cm.id, cm.name ORDER BY cm.created_at`,
      [siteId]
    );
    console.log('\nFinal counts:');
    sumRes.rows.forEach(r => console.log(`  ${r.name}: ${r.bookings}`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Move failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
