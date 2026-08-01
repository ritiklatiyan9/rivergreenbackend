import redisClient from '../config/redis.js';

const clampLimit = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
};

const defaultMinuteLimit = clampLimit(process.env.AI_CHAT_RATE_LIMIT_PER_MINUTE, 20, 120);
const defaultDailyLimit = clampLimit(process.env.AI_CHAT_RATE_LIMIT_PER_DAY, 100, 1000);

const incrementRedisCounter = async (redis, key, ttlSeconds) => {
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, ttlSeconds);
  return count;
};

export const createAssistantRateLimiter = ({
  redis = redisClient,
  minuteLimit = defaultMinuteLimit,
  dailyLimit = defaultDailyLimit,
  now = () => Date.now(),
} = {}) => {
  const counters = new Map();
  let requestsSinceCleanup = 0;

  const localIncrement = (key, expiresAt) => {
    const existing = counters.get(key);
    if (!existing || existing.expiresAt <= now()) {
      counters.set(key, { count: 1, expiresAt });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  };

  const cleanup = () => {
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup < 100 && counters.size < 5000) return;
    requestsSinceCleanup = 0;
    const timestamp = now();
    for (const [key, entry] of counters) {
      if (entry.expiresAt <= timestamp) counters.delete(key);
    }
  };

  return async (req, res, next) => {
    const userId = req.user?.id;
    const siteId = req.user?.site_id;
    if (!userId || !siteId) return next();

    const timestamp = now();
    const minuteBucket = Math.floor(timestamp / 60_000);
    const dayBucket = Math.floor(timestamp / 86_400_000);
    const scope = `${userId}:${siteId}`;
    const minuteKey = `rate:ai-chat:minute:${scope}:${minuteBucket}`;
    const dayKey = `rate:ai-chat:day:${scope}:${dayBucket}`;

    let minuteCount;
    let dayCount;
    if (redis?.isOpen && redis?.isReady) {
      try {
        [minuteCount, dayCount] = await Promise.all([
          incrementRedisCounter(redis, minuteKey, 65),
          incrementRedisCounter(redis, dayKey, 86_500),
        ]);
      } catch (error) {
        console.error('[AssistantRateLimit] Redis unavailable, using local limiter:', error.message);
      }
    }

    if (!Number.isFinite(minuteCount) || !Number.isFinite(dayCount)) {
      cleanup();
      minuteCount = localIncrement(minuteKey, (minuteBucket + 1) * 60_000 + 1000);
      dayCount = localIncrement(dayKey, (dayBucket + 1) * 86_400_000 + 1000);
    }

    const minuteRemaining = Math.max(0, minuteLimit - minuteCount);
    const dailyRemaining = Math.max(0, dailyLimit - dayCount);
    res.setHeader('RateLimit-Limit', String(minuteLimit));
    res.setHeader('RateLimit-Remaining', String(Math.min(minuteRemaining, dailyRemaining)));

    if (minuteCount > minuteLimit || dayCount > dailyLimit) {
      const retryAfter = minuteCount > minuteLimit
        ? Math.max(1, Math.ceil(((minuteBucket + 1) * 60_000 - timestamp) / 1000))
        : Math.max(1, Math.ceil(((dayBucket + 1) * 86_400_000 - timestamp) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        code: 'AI_RATE_LIMITED',
        message: 'Too many assistant requests. Please try again later.',
        retryAfter,
      });
    }

    return next();
  };
};

export const assistantRateLimit = createAssistantRateLimiter();

export default assistantRateLimit;
