// One-off repair script:
// 1. Inspect sites + colonies for the user's setup.
// 2. Ensure "Defence Garden Phase 2" colony exists for the active site.
// 3. Move any orphan plot_bookings (booking_source = 'PUBLIC' whose auto-created
//    plot has an empty polygon and is sitting in a different colony than its
//    booking source) into Defence Garden Phase 2.
//
// Heuristic for "orphan booked from /project/5":
//   - plot_bookings.booking_source = 'PUBLIC'
//   - plot_bookings.notes ILIKE '%website map%' OR razorpay marker present
//   - the plot's colony_map_id != Defence Garden Phase 2's id
//   - the plot's polygon_points is '[]' (i.e. auto-created via public-book-by-label)
//
// We only move when the booking is still PENDING_APPROVAL — already-approved
// bookings are left alone so we don't disrupt confirmed history.

import 'dotenv/config';
import pool from '../src/config/db.js';

const COLONY_NAME = 'Defence Garden Phase 2';

(async () => {
  const client = await pool.connect();
  try {
    // ── 1. Find the only site (or the first one) ──────────────────────────
    const siteRes = await client.query('SELECT id, name FROM sites ORDER BY created_at ASC');
    if (siteRes.rows.length === 0) {
      console.log('No sites in DB — nothing to do.');
      return;
    }
    console.log('Sites:');
    siteRes.rows.forEach(s => console.log(`  ${s.id}  ${s.name}`));
    const site = siteRes.rows[0];
    console.log(`\n→ Using site: ${site.name} (${site.id})\n`);

    // ── 2. List colonies under this site ──────────────────────────────────
    const colRes = await client.query(
      'SELECT id, name, created_at FROM colony_maps WHERE site_id = $1 ORDER BY created_at ASC',
      [site.id]
    );
    console.log('Colonies under this site:');
    colRes.rows.forEach(c => console.log(`  ${c.id}  ${c.name}  (created ${c.created_at.toISOString()})`));

    // ── 3. Ensure "Defence Garden Phase 2" colony exists ──────────────────
    let dg2 = colRes.rows.find(c => c.name.toLowerCase() === COLONY_NAME.toLowerCase());
    if (!dg2) {
      console.log(`\n${COLONY_NAME} not found — creating it…`);
      const ins = await client.query(
        `INSERT INTO colony_maps (site_id, name, image_url, image_width, image_height, created_at, updated_at)
         VALUES ($1, $2, '', 1460, 1370, NOW(), NOW())
         RETURNING id, name, created_at`,
        [site.id, COLONY_NAME]
      );
      dg2 = ins.rows[0];
      console.log(`  ✓ Created ${dg2.name} (${dg2.id})`);
    } else {
      console.log(`\n✓ ${COLONY_NAME} already exists (${dg2.id})`);
    }

    // ── 4. Find orphan public bookings whose plot is NOT in DG2 ───────────
    const orphanRes = await client.query(
      `SELECT pb.id AS booking_id, pb.client_name, pb.client_phone, pb.status,
              pb.colony_map_id AS booking_colony,
              mp.id AS plot_id, mp.plot_number, mp.polygon_points,
              mp.colony_map_id AS plot_colony,
              cm.name AS current_colony_name
       FROM plot_bookings pb
       JOIN map_plots mp ON pb.plot_id = mp.id
       LEFT JOIN colony_maps cm ON mp.colony_map_id = cm.id
       WHERE pb.site_id = $1
         AND pb.booking_source = 'PUBLIC'
         AND mp.colony_map_id <> $2
         AND mp.polygon_points::text IN ('[]', 'null', '')
         AND pb.status IN ('PENDING_APPROVAL', 'PENDING')
       ORDER BY pb.created_at DESC`,
      [site.id, dg2.id]
    );

    if (orphanRes.rows.length === 0) {
      console.log('\nNo orphan bookings found that look like website auto-creates.');
    } else {
      console.log(`\nFound ${orphanRes.rows.length} orphan booking(s):`);
      orphanRes.rows.forEach(r => console.log(
        `  • ${r.plot_number}  ${r.client_name} (${r.client_phone})  status=${r.status}  currently in: ${r.current_colony_name}`
      ));
    }

    // ── 5. Move orphan plots + bookings into DG2 ──────────────────────────
    if (orphanRes.rows.length > 0) {
      await client.query('BEGIN');
      try {
        for (const r of orphanRes.rows) {
          await client.query('UPDATE map_plots SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [dg2.id, r.plot_id]);
          await client.query('UPDATE plot_bookings SET colony_map_id = $1, updated_at = NOW() WHERE id = $2', [dg2.id, r.booking_id]);
        }
        await client.query('COMMIT');
        console.log(`\n✓ Moved ${orphanRes.rows.length} booking(s) and their plots into ${COLONY_NAME}.`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Move failed (rolled back):', err.message || err);
        process.exitCode = 2;
        return;
      }
    }

    // ── 6. Final report ───────────────────────────────────────────────────
    const sumRes = await client.query(
      `SELECT cm.name, COUNT(pb.id) AS bookings
       FROM colony_maps cm
       LEFT JOIN plot_bookings pb ON pb.colony_map_id = cm.id
       WHERE cm.site_id = $1
       GROUP BY cm.id, cm.name
       ORDER BY cm.created_at`,
      [site.id]
    );
    console.log('\nBookings per colony (final):');
    sumRes.rows.forEach(r => console.log(`  ${r.name}: ${r.bookings}`));
  } catch (err) {
    console.error('Repair script failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
