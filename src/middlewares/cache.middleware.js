import redisClient from '../config/redis.js';

/**
 * Express middleware that caches GET responses in Redis.
 * Cache key = cache:{userId}:{originalUrl}
 *
 * @param {number} ttl — Time-to-live in seconds (default 300 = 5 min)
 */
export const cacheMiddleware = (ttl = 300) => {
    return async (req, res, next) => {
        // Only cache GET requests
        if (req.method !== 'GET') return next();

        // Need authenticated user for per-user cache keys
        const userId = req.user?.id;
        if (!userId) return next();

        const cacheKey = `cache:${userId}:${req.originalUrl}`;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached);
                return res.json(parsed);
            }
        } catch (err) {
            // Redis down → skip cache, serve from DB
            console.error('Redis read error:', err.message);
        }

        // Intercept res.json to capture the response and cache it
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Cache in background — don't block response
            redisClient
                .setEx(cacheKey, ttl, JSON.stringify(body))
                .catch((err) => console.error('Redis write error:', err.message));
            return originalJson(body);
        };

        next();
    };
};

/**
 * Delete all Redis keys matching a glob pattern.
 * Example: bustCache('cache:*:/api/site/users*')
 *
 * @param {string} pattern — Redis SCAN glob pattern
 */
export const bustCache = async (pattern) => {
    try {
        const keys = await redisClient.keys(pattern);
        if (keys && keys.length > 0) {
            await redisClient.del(keys);
        }
    } catch (err) {
        console.error('Redis bust error:', err.message);
    }
};

export default cacheMiddleware;
