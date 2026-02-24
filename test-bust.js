import dotenv from 'dotenv';
dotenv.config();

const run = async () => {
    const { bustCache } = await import('./src/middlewares/cache.middleware.js');
    const { default: redisClient } = await import('./src/config/redis.js');
    await redisClient.connect().catch(() => null);

    await bustCache('cache:*:/api/admin/*');
    process.exit(0);
};
run();
