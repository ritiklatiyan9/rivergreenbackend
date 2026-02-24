/**
 * Adds Cache-Control headers to GET responses for browser-level caching.
 * private = only the user's browser caches it (not shared proxies).
 *
 * @param {number} maxAge — max-age in seconds (default 30)
 */
const httpCacheHeaders = (maxAge = 30) => {
    return (req, res, next) => {
        if (req.method === 'GET') {
            res.set('Cache-Control', `private, max-age=${maxAge}`);
        } else {
            res.set('Cache-Control', 'no-store');
        }
        next();
    };
};

export default httpCacheHeaders;
