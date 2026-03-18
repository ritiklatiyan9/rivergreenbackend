import dotenv from 'dotenv';

dotenv.config();

const { default: pool } = await import('../src/config/db.js');

const SOURCE_SITE_NAME = process.argv[2] || 'River Green Valley';
const TARGET_SITE_NAME = process.argv[3] || 'River Green Colony';

const EXCLUDED_TABLES = new Set([
  'sites',
  'migrations',
]);

async function getSiteByName(name) {
  const r = await pool.query(
    'SELECT id, name FROM sites WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1',
    [name],
  );
  return r.rows[0] || null;
}

async function getTablesWithSiteId() {
  const q = `
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'site_id'
    GROUP BY table_name
    ORDER BY table_name
  `;
  const r = await pool.query(q);
  return r.rows.map((row) => row.table_name).filter((t) => !EXCLUDED_TABLES.has(t));
}

async function run() {
  const source = await getSiteByName(SOURCE_SITE_NAME);
  const target = await getSiteByName(TARGET_SITE_NAME);

  if (!source) {
    throw new Error(`Source site not found: ${SOURCE_SITE_NAME}`);
  }
  if (!target) {
    throw new Error(`Target site not found: ${TARGET_SITE_NAME}`);
  }
  if (source.id === target.id) {
    throw new Error('Source and target site are same');
  }

  console.log(`Moving data from "${source.name}" (${source.id}) to "${target.name}" (${target.id})`);

  const tables = await getTablesWithSiteId();
  const summary = [];

  for (const tableName of tables) {
    try {
      const sql = `UPDATE ${tableName} SET site_id = $1 WHERE site_id = $2`;
      const res = await pool.query(sql, [target.id, source.id]);
      summary.push({ table: tableName, moved: res.rowCount, status: 'ok' });
    } catch (err) {
      summary.push({ table: tableName, moved: 0, status: `skipped: ${err.code || err.message}` });
    }
  }

  console.table(summary);

  let remainingTotal = 0;
  for (const tableName of tables) {
    try {
      const c = await pool.query(`SELECT COUNT(*)::int AS cnt FROM ${tableName} WHERE site_id = $1`, [source.id]);
      remainingTotal += c.rows[0]?.cnt || 0;
    } catch {
      // ignore count failures for incompatible tables
    }
  }

  console.log(`Remaining rows in source site across audited tables: ${remainingTotal}`);

  console.log('Done.');
  await pool.end();
}

run().catch(async (err) => {
  console.error(err.message || err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
