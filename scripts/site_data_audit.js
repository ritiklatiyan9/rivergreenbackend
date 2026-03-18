import dotenv from 'dotenv';

dotenv.config();

const { default: pool } = await import('../src/config/db.js');

const TABLES = [
  'users',
  'leads',
  'contacts',
  'calls',
  'followups',
  'teams',
  'colony_maps',
  'map_plots',
  'plot_bookings',
  'payments',
  'clients',
  'client_activities',
  'user_categories',
  'user_profiles',
  'chat_conversations',
  'chat_messages',
  'chat_permissions',
  'financial_settings',
  'site_financial_settings',
  'content_shares',
  'shift_to_call_queue',
  'contact_import_jobs',
  'team_targets'
];

async function tableExists(tableName) {
  const q = `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS present
  `;
  const r = await pool.query(q, [tableName]);
  return Boolean(r.rows[0]?.present);
}

async function run() {
  const sites = await pool.query('SELECT id, name FROM sites ORDER BY created_at ASC');
  console.log('Sites:');
  console.table(sites.rows);

  for (const t of TABLES) {
    const exists = await tableExists(t);
    if (!exists) continue;

    const q = `
      SELECT site_id::text AS site_id, COUNT(*)::int AS count
      FROM ${t}
      GROUP BY site_id
      ORDER BY count DESC
    `;

    try {
      const r = await pool.query(q);
      if (r.rows.length > 0) {
        console.log(`\n${t}:`);
        console.table(r.rows);
      }
    } catch (e) {
      // Ignore tables that don't have site_id after all.
    }
  }

  await pool.end();
}

run().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
