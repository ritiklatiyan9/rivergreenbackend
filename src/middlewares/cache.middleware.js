import redisClient from '../config/redis.js';

// ─── L1: In-Process Memory Cache ─────────────────────────────────────────────
// Sub-millisecond reads for hot keys before falling back to Redis.
// Keys are evicted when the TTL expires or on explicit bust.

function globToRegex(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

class MemCache {
    constructor(maxSize = 3000) {
        this._map = new Map();
        this._maxSize = maxSize;
    }

    set(key, value, ttlSeconds) {
        if (this._map.size >= this._maxSize) {
            // Evict the oldest (first) entry
            this._map.delete(this._map.keys().next().value);
        }
        this._map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    }

    get(key) {
        const entry = this._map.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAt) {
            this._map.delete(key);
            return undefined;
        }
        return entry.value;
    }

    deleteByPattern(glob) {
        const regex = globToRegex(glob);
        for (const key of this._map.keys()) {
            if (regex.test(key)) this._map.delete(key);
        }
    }

    get size() { return this._map.size; }
}

export const memCache = new MemCache(3000);

// ─── Cache Middleware ────────────────────────────────────────────────────────
/**
 * Two-tier GET cache middleware.
 *   Tier 1 – in-process MemCache  (~0 ms, evicted by TTL or explicit bust)
 *   Tier 2 – Redis                (~1-2 ms, survives restarts)
 *
 * Cache key = cache:{userId}:{originalUrl}
 * @param {number} ttl  TTL in seconds (default 300 = 5 min)
 */
export const cacheMiddleware = (ttl = 300) => {
    // L1 TTL is capped at 120 s so L2 Redis remains authoritative
    const l1Ttl = Math.min(ttl, 120);
    const isRedisAvailable = () => redisClient?.isOpen && redisClient?.isReady;

    return async (req, res, next) => {
        if (req.method !== 'GET') return next();

        const userId = req.user?.id;
        if (!userId) return next();

        const cacheKey = `cache:${userId}:${req.originalUrl}`;

        // Tier-1: memory hit
        const l1 = memCache.get(cacheKey);
        if (l1 !== undefined) {
            res.setHeader('X-Cache', 'L1');
            return res.json(l1);
        }

        // Tier-2: Redis hit
        if (isRedisAvailable()) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    memCache.set(cacheKey, parsed, l1Ttl);  // promote to L1
                    res.setHeader('X-Cache', 'L2');
                    return res.json(parsed);
                }
            } catch (err) {
                console.error('[Cache] Redis read error:', err.message);
            }
        }

        // Cache miss → intercept res.json to populate both tiers
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (isRedisAvailable()) {
                redisClient
                    .setEx(cacheKey, ttl, JSON.stringify(body))
                    .catch((err) => console.error('[Cache] Redis write error:', err.message));
            }
            memCache.set(cacheKey, body, l1Ttl);
            res.setHeader('X-Cache', 'MISS');
            return originalJson(body);
        };

        next();
    };
};

// ─── Cache Busting ───────────────────────────────────────────────────────────
/**
 * Bust all cache keys matching a Redis glob pattern.
 * Clears both the L1 in-process cache and L2 Redis (via cursor SCAN).
 * Fire-and-forget safe — never throws.
 *
 * @param {string} pattern  e.g. 'cache:*:/api/leads*'
 */
export const bustCache = async (pattern) => {
    // Always clear L1 synchronously
    memCache.deleteByPattern(pattern);
    if (!(redisClient?.isOpen && redisClient?.isReady)) return;
    // Clear L2 Redis via SCAN (cursor-safe, no KEYS block)
    try {
        let cursor = 0;
        do {
            const result = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
            cursor = result.cursor;
            if (result.keys.length > 0) {
                await redisClient.del(result.keys);
            }
        } while (cursor !== 0);
    } catch (err) {
        console.error('[Cache] Redis bust error:', err.message);
    }
};

/**
 * Bust multiple patterns in parallel.
 * @param {...string} patterns
 */
export const bustMany = (...patterns) => Promise.all(patterns.map(bustCache));

export default cacheMiddleware;
