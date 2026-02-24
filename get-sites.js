import dotenv from 'dotenv';
dotenv.config();

const getPool = async () => {
    const { default: pool } = await import('./src/config/db.js');
    return pool;
};

getPool().then(pool => {
    return pool.query("SELECT * FROM sites");
}).then(res => {
    console.log("Total sites:", res.rows.length);
    console.table(res.rows);
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
