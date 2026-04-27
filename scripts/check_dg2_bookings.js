// Sanity check: confirm the admin Bookings + Pending Approvals + stats endpoints
// will return the moved bookings under Defence Garden Phase 2.

import 'dotenv/config';
import pool from '../src/config/db.js';
import plotBookingModel from '../src/models/PlotBooking.model.js';

(async () => {
  try {
    const siteRes = await pool.query('SELECT id FROM sites ORDER BY created_at LIMIT 1');
    const siteId = siteRes.rows[0].id;
    const cmRes = await pool.query(
      "SELECT id FROM colony_maps WHERE LOWER(name) = LOWER('Defence Garden Phase 2') AND site_id = $1",
      [siteId]
    );
    const dg2Id = cmRes.rows[0]?.id;
    console.log('siteId =', siteId);
    console.log('dg2Id  =', dg2Id, '\n');

    // Mirrors what GET /bookings?colony_map_id=… returns
    const list = await plotBookingModel.findBySite({ siteId, colonyMapId: dg2Id, page: 1, limit: 20 }, pool);
    console.log(`/bookings?colony_map_id=${dg2Id}  →  ${list.bookings.length} of ${list.pagination.total}`);
    list.bookings.forEach(b => console.log(`  • ${b.plot_number}  ${b.client_name}  (${b.status})`));

    // Pending approvals
    const pending = await plotBookingModel.findBySite({ siteId, status: 'PENDING_APPROVAL', colonyMapId: dg2Id, page: 1, limit: 100 }, pool);
    console.log(`\n/bookings/pending-approvals?colony_map_id=${dg2Id}  →  ${pending.bookings.length}`);

    // Stats
    const stats = await plotBookingModel.getStats(siteId, pool, null, dg2Id);
    console.log('\nstats:', stats);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
