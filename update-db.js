import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}?sslmode=require`,
});

async function run() {
    try {
        await pool.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS address TEXT, ADD COLUMN IF NOT EXISTS profession VARCHAR(255);`);
        console.log('Successfully added address and profession to leads');
        await pool.query(`ALTER TABLE site_financial_settings ADD COLUMN IF NOT EXISTS colony_image_url TEXT;`);
        console.log('Successfully added colony_image_url to site_financial_settings');
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
