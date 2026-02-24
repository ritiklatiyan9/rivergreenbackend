import dotenv from 'dotenv';
dotenv.config();

const getPool = async () => {
    const { default: pool } = await import('./src/config/db.js');
    return pool;
};

getPool().then(pool => {
    return pool.query("SELECT * FROM users");
}).then(res => {
    console.log("Total users:", res.rows.length);
    console.table(res.rows.map(u => ({ id: u.id, email: u.email, role: u.role, password: u.password })));
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
