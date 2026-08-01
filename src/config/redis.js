import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = createClient({
    url: REDIS_URL,
    socket: {
        connectTimeout: 3_000,
        keepAlive: true,
        reconnectStrategy: (retries) => {
            if (retries > 5) return false;
            return Math.min(100 * (2 ** retries), 3_000);
        },
    },
});

redisClient.on('error', (err) => console.error('Redis error:', err.message));
redisClient.on('connect', () => console.log('Connected to Redis'));
redisClient.on('ready', () => console.log('Redis cache ready'));

export const connectRedis = async () => {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
};

export const closeRedis = async () => {
    if (redisClient.isOpen) await redisClient.quit();
};

export default redisClient;
