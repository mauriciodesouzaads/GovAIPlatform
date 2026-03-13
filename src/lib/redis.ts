import IORedis from 'ioredis';

/**
 * General-purpose Redis client for caching, rate-limit counters, and health checks.
 * BullMQ Queues and Workers must use their own dedicated IORedis connections
 * (with maxRetriesPerRequest: null) — do NOT reuse this client for BullMQ.
 */
export const redisCache = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: false,
});

redisCache.on('error', (err) => {
    // Non-fatal: rate-limit and cache degrade gracefully on Redis failure.
    console.error('[Redis Cache] Connection error:', err.message);
});
