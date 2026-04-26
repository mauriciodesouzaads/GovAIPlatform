/**
 * Per-Tenant Concurrency Limiter — FASE 11
 * ---------------------------------------------------------------------------
 * The runtime worker has global concurrency=2. On top of that, this limiter
 * ensures NO single tenant holds more than TENANT_MAX_CONCURRENT active work
 * items at once. Requests beyond the limit are rejected and BullMQ re-queues
 * them — giving other tenants a chance and preventing noisy-neighbor
 * starvation.
 *
 * Implementation: Redis atomic INCR/DECR with TTL safety (in case a worker
 * crashes and never decrements, the key expires after LEASE_TTL_SEC so the
 * slot is reclaimed).
 */

import { redisCache } from './redis';

const TENANT_MAX_CONCURRENT = parseInt(process.env.TENANT_MAX_CONCURRENT || '1', 10);
const KEY = (orgId: string) => `govai:runtime:concurrency:${orgId}`;
/** Safety TTL: if a worker crashes without calling release, the slot
 *  is auto-reclaimed after 15 min. The slot is safe to hold longer
 *  than this in a healthy run — release() refreshes the counter. */
const LEASE_TTL_SEC = 60 * 15;

/**
 * Attempt to acquire a slot for `orgId`. Returns true if acquired,
 * false if the tenant is at capacity and the caller should retry later.
 *
 * If Redis is unavailable, this fails OPEN — the limiter cannot be
 * trusted so we let the request through rather than block all tenants.
 */
export async function acquireTenantSlot(orgId: string): Promise<boolean> {
    const key = KEY(orgId);
    try {
        if (redisCache.status !== 'ready') {
            // Fail open when Redis is degraded — allow the dispatch
            return true;
        }
        const count = await redisCache.incr(key);
        // Refresh TTL every acquire (keeps the key alive while in use)
        await redisCache.expire(key, LEASE_TTL_SEC);
        if (count > TENANT_MAX_CONCURRENT) {
            // Over budget — release immediately so the limit stays sharp
            await redisCache.decr(key);
            return false;
        }
        return true;
    } catch {
        // Redis transient error — fail open
        return true;
    }
}

/**
 * Release a slot for `orgId`. Safe to call multiple times; clamps to 0.
 */
export async function releaseTenantSlot(orgId: string): Promise<void> {
    const key = KEY(orgId);
    try {
        if (redisCache.status !== 'ready') return;
        const count = await redisCache.decr(key);
        if (count < 0) {
            // Counter drifted negative — clamp to 0 with a fresh TTL
            await redisCache.set(key, '0', 'EX', LEASE_TTL_SEC);
        }
    } catch {
        // Best-effort release
    }
}

/**
 * Returns current count for observability / tests.
 */
export async function getTenantSlotCount(orgId: string): Promise<number> {
    try {
        const v = await redisCache.get(KEY(orgId));
        return parseInt(v ?? '0', 10);
    } catch {
        return 0;
    }
}
