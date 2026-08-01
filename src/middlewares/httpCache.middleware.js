/**
 * Adds Cache-Control headers to GET responses for browser-level caching.
 * private = only the user's browser caches it (not shared proxies).
 *
 * @param {number} maxAge — max-age in seconds (default 30)
 */
const httpCacheHeaders = (maxAge = 30) => {
    return (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
            // Authenticated API data can change immediately after a mutation.
            // Keep browser storage revalidation-only; the server L1/Redis cache
            // remains the authoritative, explicitly invalidated fast path.
            res.set('Cache-Control', 'private, no-cache, must-revalidate');
            res.set('Vary', 'Authorization, x-site-id, Origin');
        } else {
            res.set('Cache-Control', 'no-store');
        }
        next();
    };
};

export default httpCacheHeaders;
