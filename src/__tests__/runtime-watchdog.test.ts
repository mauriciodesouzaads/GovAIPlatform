import { describe, it, expect, vi } from 'vitest';

describe('Runtime Watchdog', () => {
    it('detectAndMarkStuckWorkItems is exported and callable', async () => {
        const mod = await import('../lib/runtime-delegation');
        expect(typeof mod.detectAndMarkStuckWorkItems).toBe('function');
    });

    it('uses ARCHITECT_STUCK_THRESHOLD_MIN when set', async () => {
        // Verify the env var is read at call time (not cached at module
        // load). This matters for testability and config changes.
        const orig = process.env.ARCHITECT_STUCK_THRESHOLD_MIN;
        process.env.ARCHITECT_STUCK_THRESHOLD_MIN = '30';

        // Mock a pool that returns no rows — we just want to verify the
        // function doesn't crash and runs through cleanly.
        const mockClient = {
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: vi.fn(),
        };
        const mockPool = {
            connect: vi.fn().mockResolvedValue(mockClient),
        };

        const { detectAndMarkStuckWorkItems } = await import('../lib/runtime-delegation');
        const count = await detectAndMarkStuckWorkItems(mockPool as any);

        expect(count).toBe(0);
        // Verify the query was called with threshold 30 (as $1 parameter)
        const selectCall = mockClient.query.mock.calls.find((c: any[]) =>
            typeof c[0] === 'string' && c[0].includes('last_event_at')
        );
        expect(selectCall).toBeDefined();
        expect(selectCall![1]).toEqual([30]);

        process.env.ARCHITECT_STUCK_THRESHOLD_MIN = orig;
    });

    it('returns 0 when no stuck items exist', async () => {
        const mockClient = {
            query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
            release: vi.fn(),
        };
        const mockPool = {
            connect: vi.fn().mockResolvedValue(mockClient),
        };

        const { detectAndMarkStuckWorkItems } = await import('../lib/runtime-delegation');
        const count = await detectAndMarkStuckWorkItems(mockPool as any);
        expect(count).toBe(0);
        expect(mockClient.release).toHaveBeenCalled();
    });
});
