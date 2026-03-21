import 'dotenv/config';
import pool from './src/config/db.js';

async function createTable() {
  try {
    const res = await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_live_locations (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        latitude NUMERIC(10, 8),
        longitude NUMERIC(11, 8),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table created!');
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    process.exit(0);
  }
}
createTable();
