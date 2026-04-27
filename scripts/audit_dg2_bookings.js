// Audit the 9 bookings I moved into Defence Garden Phase 2 — show created_at,
// notes, and current colony so the user can decide which are genuine DG2 vs
// old River Green orphans.

import 'dotenv/config';
import pool from '../src/config/db.js';

const COLONY_NAME = 'Defence Garden Phase 2';

(async () => {
  try {
    const cmRes = await pool.query("SELECT id FROM colony_maps WHERE LOWER(name) = LOWER($1) LIMIT 1", [COLONY_NAME]);
    const dg2Id = cmRes.rows[0]?.id;
    if (!dg2Id) { console.log('No DG2 colony.'); return; }

    const r = await pool.query(
      `SELECT pb.id AS booking_id, pb.client_name, pb.client_phone, pb.status,
              pb.created_at, pb.notes, mp.plot_number,
              jsonb_array_length(mp.polygon_points) AS poly_len
       FROM plot_bookings pb
       JOIN map_plots mp ON pb.plot_id = mp.id
       WHERE pb.colony_map_id = $1
       ORDER BY pb.created_at ASC`,
      [dg2Id]
    );

    console.log(`Bookings currently in ${COLONY_NAME}: ${r.rows.length}\n`);
    r.rows.forEach((b, i) => {
      const notes = (b.notes || '').slice(0, 100);
      console.log(
        `${String(i + 1).padStart(2)}. ${b.created_at.toISOString()}  ` +
        `${b.plot_number.padEnd(6)}  ${(b.client_name || '').padEnd(20)} ` +
        `${(b.client_phone || '').padEnd(12)}  poly=${b.poly_len}  ` +
        `id=${b.booking_id}\n      notes: ${notes}`
      );
    });
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
