import { createHash } from 'crypto';

// ─── In-Process Memory Cache ─────────────────────────────────────────────
// Sub-millisecond reads for hot keys. Keys are evicted when the TTL expires
// or on explicit bust. A prior Redis L2 tier was removed after its endpoint's
// DNS stopped resolving in production and calls to it blocked requests with
// no timeout — this app runs as a single process, so L1 alone is correct.

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
// keys. Expand those patterns explicitly so L1 invalidation remains correct
// for cache:{user}:{site}:{url}.
export const normalizeCachePattern = (pattern) => {
    const value = String(pattern || '');
    return value.startsWith('cache:*:/api/')
        ? value.replace('cache:*:/api/', 'cache:*:*:/api/')
        : value;
};

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
 * In-process GET cache middleware, ~0 ms reads, evicted by TTL or explicit bust.
 * Cache key = cache:{userId}:{siteId}:{originalUrl}
 * @param {number} ttl  TTL in seconds (default 300 = 5 min)
 */
export const cacheMiddleware = (ttl = 300) => {
    const resolvedTtl = normalizeTtl(ttl);

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

        const hit = memCache.get(cacheKey);
        if (hit !== undefined) {
            res.setHeader('X-Cache', 'HIT');
            return res.json(hit);
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

        // Cache miss → intercept res.json to populate the cache
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
            memCache.set(cacheKey, body, resolvedTtl);
            res.setHeader('X-Cache', 'MISS');
            settle({ cacheable: true, body });
            return originalJson(body);
        };

        next();
    };
};

const waitForFlight = (promise) => new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), COALESCE_WAIT_MS);
    timeout.unref?.();
    promise.then((value) => {
        clearTimeout(timeout);
        resolve(value);
    });
});

// ─── Cache Busting ───────────────────────────────────────────────────────────
/**
 * Bust all cache keys matching a glob pattern.
 * Fire-and-forget safe — never throws.
 *
 * @param {string} pattern  e.g. 'cache:*:/api/leads*'
 */
export const bustCache = async (pattern) => {
    memCache.deleteByPattern(normalizeCachePattern(pattern));
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
