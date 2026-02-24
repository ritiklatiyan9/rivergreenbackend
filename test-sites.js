import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
    const { default: pool } = await import('./src/config/db.js');
    const { default: siteModel } = await import('./src/models/Site.model.js');

    // Test fetch for specific owner ID
    const ownerId = "ffd517af-b3f4-4a8b-bd6b-5254e6855945";
    const sites = await siteModel.findWithAdminCount(ownerId, pool);
    console.log("Sites for owner:", sites.length);
    console.log(sites);

    // Also fetch all 
    const all = await pool.query('SELECT * FROM sites');
    console.log("All sites in DB:", all.rows.length);

    process.exit(0);
};
run();
