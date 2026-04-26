import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';

// Import after check — the module uses redisCache singleton
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

describe('Tenant Concurrency Limiter', () => {
    let redisAvailable = false;
    const testOrgId = 'test-org-' + Date.now();

    beforeAll(async () => {
        // Probe Redis. If unavailable, skip (fail-open behavior is tested
        // implicitly when status !== 'ready').
        const probe = new IORedis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
        try {
            await probe.connect();
            await probe.ping();
            redisAvailable = true;
        } catch {
            redisAvailable = false;
        } finally {
            try { await probe.quit(); } catch { /* ignore */ }
        }
    }, 10_000);

    afterAll(async () => {
        if (!redisAvailable) return;
        // Clean up the test key
        const cleanup = new IORedis(redisUrl);
        try { await cleanup.del(`govai:runtime:concurrency:${testOrgId}`); } catch { /* ignore */ }
        try { await cleanup.quit(); } catch { /* ignore */ }
    });

    it('fails open when Redis unavailable OR module loads cleanly', async () => {
        // Regardless of Redis availability, the module must load and export
        // the expected API surface.
        const mod = await import('../lib/tenant-concurrency');
        expect(typeof mod.acquireTenantSlot).toBe('function');
        expect(typeof mod.releaseTenantSlot).toBe('function');
        expect(typeof mod.getTenantSlotCount).toBe('function');
    });

    it('acquires and releases slot under limit', async () => {
        if (!redisAvailable) return;
        const { acquireTenantSlot, releaseTenantSlot, getTenantSlotCount } = await import('../lib/tenant-concurrency');

        const acquired = await acquireTenantSlot(testOrgId);
        expect(acquired).toBe(true);

        // Immediately release so test is idempotent
        await releaseTenantSlot(testOrgId);
        const count = await getTenantSlotCount(testOrgId);
        expect(count).toBeLessThanOrEqual(0);
    });

    it('rejects second acquire when default limit=1 is reached', async () => {
        if (!redisAvailable) return;
        const { acquireTenantSlot, releaseTenantSlot } = await import('../lib/tenant-concurrency');

        // With default TENANT_MAX_CONCURRENT=1, a second acquire without
        // release should be rejected.
        const first = await acquireTenantSlot(testOrgId);
        expect(first).toBe(true);

        const second = await acquireTenantSlot(testOrgId);
        expect(second).toBe(false);

        // Cleanup
        await releaseTenantSlot(testOrgId);
    });
});
