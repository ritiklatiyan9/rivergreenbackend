// Wipe ALL plot_bookings + payments for the active site, then reset every plot
// back to AVAILABLE. Auto-created spurious plots (empty polygon, no real
// metadata) are also deleted so the admin colony cards show clean counts.
//
// Run with: node scripts/wipe_bookings_payments.js
// Add `--keep-plots` to preserve all existing plots (only reset their status).

import 'dotenv/config';
import pool from '../src/config/db.js';

const KEEP_PLOTS = process.argv.includes('--keep-plots');

(async () => {
  const client = await pool.connect();
  try {
    const sites = await client.query('SELECT id, name FROM sites ORDER BY created_at LIMIT 1');
    if (sites.rows.length === 0) { console.log('No sites.'); return; }
    const siteId = sites.rows[0].id;
    console.log(`Wiping data for site: ${sites.rows[0].name} (${siteId})\n`);

    await client.query('BEGIN');

    // 1. Delete payments
    const pay = await client.query('DELETE FROM payments WHERE site_id = $1 RETURNING id', [siteId]);
    console.log(`  ✓ Deleted ${pay.rowCount} payment row(s)`);

    // 2. Delete bookings
    const bk = await client.query('DELETE FROM plot_bookings WHERE site_id = $1 RETURNING id', [siteId]);
    console.log(`  ✓ Deleted ${bk.rowCount} booking row(s)`);

    // 3. Reset plot statuses + clear owner fields
    const plotsReset = await client.query(
      `UPDATE map_plots SET status = 'AVAILABLE', owner_name = NULL, owner_phone = NULL,
              owner_email = NULL, booking_date = NULL, booking_amount = NULL,
              referred_by = NULL, updated_at = NOW()
       WHERE site_id = $1 RETURNING id`,
      [siteId]
    );
    console.log(`  ✓ Reset ${plotsReset.rowCount} plot(s) to AVAILABLE`);

    // 4. Delete spurious auto-created plots (empty polygon, no facing/area)
    if (!KEEP_PLOTS) {
      const auto = await client.query(
        `DELETE FROM map_plots
         WHERE site_id = $1
           AND (polygon_points::text IN ('[]', 'null', '') OR polygon_points IS NULL)
           AND area_sqft IS NULL
           AND total_price IS NULL
         RETURNING id, plot_number`,
        [siteId]
      );
      console.log(`  ✓ Deleted ${auto.rowCount} auto-created plot(s)`);
    } else {
      console.log('  ↷ Skipped auto-plot delete (--keep-plots)');
    }

    await client.query('COMMIT');

    // Final summary
    const sumRes = await client.query(
      `SELECT cm.name,
              (SELECT COUNT(*) FROM map_plots mp WHERE mp.colony_map_id = cm.id) AS plots,
              (SELECT COUNT(*) FROM plot_bookings pb WHERE pb.colony_map_id = cm.id) AS bookings
       FROM colony_maps cm
       WHERE cm.site_id = $1
       ORDER BY cm.created_at`,
      [siteId]
    );
    console.log('\nFinal counts per colony:');
    sumRes.rows.forEach(r => console.log(`  ${r.name.padEnd(28)}  plots=${r.plots}  bookings=${r.bookings}`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Wipe failed (rolled back):', err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
