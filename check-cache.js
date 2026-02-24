import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
    const { default: redisClient } = await import('./src/config/redis.js');
    await redisClient.connect().catch(() => null);
    const keys = await redisClient.keys('cache:*');
    console.log("Cached keys:", keys);

    // specifically checking the sites cache key
    // GET /api/admin/sites

    for (let k of keys) {
        if (k.includes('sites')) {
            const val = await redisClient.get(k);
            console.log(`Key ${k} = ${val}`);
        }
    }
    process.exit(0);
};
run();
