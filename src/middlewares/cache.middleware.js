import redisClient from '../config/redis.js';
import { createHash } from 'crypto';

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
        // Re-inserting moves a hot key to the end of the Map (simple LRU).
        this._map.delete(key);
        if (this._map.size >= this._maxSize) {
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
        this._map.delete(key);
        this._map.set(key, entry);
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
const inFlightRequests = new Map();
const COALESCE_WAIT_MS = 5_000;

const normalizeTtl = (value) => Math.min(Math.max(Number(value) || 300, 1), 3_600);

// Legacy controllers used cache:*:/api/... before site scoping was added to
// keys. Expand those patterns explicitly so both L1 and Redis invalidations
// remain correct for cache:{user}:{site}:{url}.
export const normalizeCachePattern = (pattern) => {
    const value = String(pattern || '');
    return value.startsWith('cache:*:/api/')
        ? value.replace('cache:*:/api/', 'cache:*:*:/api/')
        : value;
};

const waitForFlight = (promise) => new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), COALESCE_WAIT_MS);
    timeout.unref?.();
    promise.then((value) => {
        clearTimeout(timeout);
        resolve(value);
    });
});

const cacheUrlPart = (originalUrl) => {
    const [pathname, rawQuery = ''] = String(originalUrl || '').split('?', 2);
    if (!rawQuery) return pathname;
    const params = new URLSearchParams(rawQuery);
    params.sort();
    const digest = createHash('sha256').update(params.toString()).digest('hex').slice(0, 20);
    return `${pathname}:q:${digest}`;
};

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
    const resolvedTtl = normalizeTtl(ttl);
    // L1 TTL is capped at 120 s so L2 Redis remains authoritative
    const l1Ttl = Math.min(resolvedTtl, 120);
    const isRedisAvailable = () => redisClient?.isOpen && redisClient?.isReady;

    return async (req, res, next) => {
        if (req.method !== 'GET') return next();

        const userId = req.user?.id;
        if (!userId) return next();

        // Scope cache by effective site to prevent cross-site response bleed.
        // authMiddleware has already resolved and authorized the effective
        // site. Never key on the raw x-site-id header: an unauthorized header
        // intentionally falls back to the user's real site.
        const effectiveSiteId = String(req.user?.site_id || 'no-site');

        const cacheKey = `cache:${userId}:${effectiveSiteId}:${cacheUrlPart(req.originalUrl)}`;

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

        // Prevent a burst of identical cold requests from all hitting the DB.
        // Followers wait briefly for the first response, then fall through if
        // the leader is slow or produced a non-cacheable response.
        const existingFlight = inFlightRequests.get(cacheKey);
        if (existingFlight) {
            const flightResult = await waitForFlight(existingFlight);
            if (flightResult?.cacheable) {
                res.setHeader('X-Cache', 'COALESCED');
                return res.json(flightResult.body);
            }
        }

        let settleFlight;
        let flightSettled = false;
        const flight = new Promise((resolve) => { settleFlight = resolve; });
        inFlightRequests.set(cacheKey, flight);

        const settle = (result) => {
            if (flightSettled) return;
            flightSettled = true;
            if (inFlightRequests.get(cacheKey) === flight) inFlightRequests.delete(cacheKey);
            settleFlight(result);
        };

        res.once('finish', () => settle({ cacheable: false }));
        res.once('close', () => settle({ cacheable: false }));

        // Cache miss → intercept res.json to populate both tiers
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            const cacheable = res.statusCode >= 200
                && res.statusCode < 300
                && !(body && body.success === false)
                && !String(res.getHeader('Cache-Control') || '').includes('no-store');

            if (!cacheable) {
                res.setHeader('X-Cache', 'SKIP');
                settle({ cacheable: false });
                return originalJson(body);
            }
            if (isRedisAvailable()) {
                const serialized = JSON.stringify(body);
                redisClient
                    .setEx(cacheKey, resolvedTtl, serialized)
                    .catch((err) => console.error('[Cache] Redis write error:', err.message));
            }
            memCache.set(cacheKey, body, l1Ttl);
            res.setHeader('X-Cache', 'MISS');
            settle({ cacheable: true, body });
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
    const normalizedPattern = normalizeCachePattern(pattern);
    // Always clear L1 synchronously
    memCache.deleteByPattern(normalizedPattern);
    if (!(redisClient?.isOpen && redisClient?.isReady)) return;
    // Clear L2 Redis via the cursor-safe async iterator (never KEYS).
    try {
        for await (const batch of redisClient.scanIterator({ MATCH: normalizedPattern, COUNT: 200 })) {
            const keys = Array.isArray(batch) ? batch : [batch];
            if (keys.length > 0) await redisClient.del(keys);
        }
    } catch (err) {
        console.error('[Cache] Redis bust error:', err.message);
    }
};

/**
 * Bust multiple patterns in parallel.
 * @param {...string} patterns
 */
export const bustMany = (...patterns) => Promise.all(patterns.map(bustCache));

/**
 * Invalidate route families only for the mutated site while retaining cache
 * hits for other sites. Paths should look like /api/leads or /api/dashboard.
 */
export const bustSiteCache = (siteId, ...paths) => {
    if (!siteId) return bustMany(...paths.map((path) => `cache:*:*:${path}*`));
    return bustMany(...paths.map((path) => `cache:*:${siteId}:${path}*`));
};

export default cacheMiddleware;
