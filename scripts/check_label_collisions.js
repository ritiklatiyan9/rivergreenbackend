// For each label currently in DG2 (the 9 orphans), check whether River Green
// already has a real plot with the same label — and look for the user's actual
// /project/5 booking (any RG booking newer than 2026-04-25T06:00).

import 'dotenv/config';
import pool from '../src/config/db.js';

(async () => {
  try {
    const sites = await pool.query('SELECT id, name FROM sites ORDER BY created_at LIMIT 1');
    const siteId = sites.rows[0].id;
    const cm = await pool.query("SELECT id, name FROM colony_maps WHERE site_id = $1 ORDER BY created_at", [siteId]);
    const rg = cm.rows.find(c => c.name === 'River Green Colony');
    const dg2 = cm.rows.find(c => c.name === 'Defence Garden Phase 2');

    const labels = ['C-12', 'C-13', 'C-14', 'C-15', 'C-16', 'C-17', 'C-18', 'C-19', 'A-53'];

    console.log('Label collisions per colony:\n');
    for (const lbl of labels) {
      const r = await pool.query(
        `SELECT cm.name AS colony, mp.plot_number, jsonb_array_length(mp.polygon_points) AS poly_len, mp.id
         FROM map_plots mp
         JOIN colony_maps cm ON mp.colony_map_id = cm.id
         WHERE cm.site_id = $1 AND UPPER(mp.plot_number) = UPPER($2)
         ORDER BY cm.created_at`,
        [siteId, lbl]
      );
      console.log(`  ${lbl.padEnd(6)} →`);
      r.rows.forEach(row => console.log(`    • ${row.colony.padEnd(28)} poly=${row.poly_len}  plot_id=${row.id}`));
    }

    console.log('\nBookings in River Green Colony, newest first:');
    const rgB = await pool.query(
      `SELECT pb.created_at, pb.client_name, pb.client_phone, mp.plot_number,
              jsonb_array_length(mp.polygon_points) AS poly_len, pb.status, pb.id
       FROM plot_bookings pb
       JOIN map_plots mp ON pb.plot_id = mp.id
       WHERE pb.colony_map_id = $1
       ORDER BY pb.created_at DESC LIMIT 10`,
      [rg.id]
    );
    rgB.rows.forEach(b =>
      console.log(`  ${b.created_at.toISOString()}  ${b.plot_number.padEnd(6)}  ${b.client_name}  poly=${b.poly_len}  status=${b.status}`)
    );

    console.log('\nMost recent bookings across the entire site (any colony):');
    const all = await pool.query(
      `SELECT pb.created_at, cm.name AS colony, pb.client_name, mp.plot_number,
              jsonb_array_length(mp.polygon_points) AS poly_len, pb.status
       FROM plot_bookings pb
       JOIN map_plots mp ON pb.plot_id = mp.id
       JOIN colony_maps cm ON pb.colony_map_id = cm.id
       WHERE pb.site_id = $1
       ORDER BY pb.created_at DESC LIMIT 15`,
      [siteId]
    );
    all.rows.forEach(b =>
      console.log(`  ${b.created_at.toISOString()}  ${b.colony.padEnd(28)}  ${b.plot_number.padEnd(6)}  ${b.client_name}  poly=${b.poly_len}`)
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
