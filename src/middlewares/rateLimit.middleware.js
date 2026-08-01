const buckets = new Map();

const pruneBuckets = (now) => {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
};

export const rateLimit = ({ windowMs, max, keyPrefix, keyGenerator }) => (req, res, next) => {
  const now = Date.now();
  pruneBuckets(now);
  const suffix = keyGenerator?.(req) || req.ip || req.socket?.remoteAddress || 'unknown';
  const key = `${keyPrefix}:${suffix}`;
  let bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  res.setHeader('RateLimit-Limit', String(max));
  res.setHeader('RateLimit-Remaining', String(Math.max(max - bucket.count, 0)));
  res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1_000)));

  if (bucket.count > max) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again shortly.',
      requestId: req.id,
    });
  }

  return next();
};

export const _clearRateLimitBucketsForTests = () => buckets.clear();

export default rateLimit;
