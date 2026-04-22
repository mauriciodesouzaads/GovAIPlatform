/**
 * Unit tests — FASE 13.5a1
 * ---------------------------------------------------------------------------
 * Exercises two extracted helpers that together form the TENANT_LIMIT
 * orphan fix:
 *
 *   - handleTenantLimitRejection (src/workers/architect.worker.ts)
 *     Re-enqueues a dispatch job with a fresh attempts budget, or marks
 *     the work_item blocked after `TENANT_LIMIT_MAX_REQUEUES` requeues.
 *
 *   - recoverOrphanedPendingWorkItems (src/lib/architect-delegation.ts)
 *     Sweeps `status='pending' AND dispatch_attempts=0` rows older than
 *     `ARCHITECT_ORPHAN_THRESHOLD_MIN`, re-enqueues if no live BullMQ job,
 *     and marks blocked after `ARCHITECT_MAX_RECOVERY_ATTEMPTS` attempts.
 *
 * Both exercise pool + queue via in-memory mocks — no DB, no Redis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleTenantLimitRejection } from '../workers/architect.worker';
import { recoverOrphanedPendingWorkItems } from '../lib/architect-delegation';

// ── Fixtures ──────────────────────────────────────────────────────────────

const ORG = '00000000-0000-0000-0000-000000000001';
const WI  = '00000000-0000-0000-0002-000000000099';

function makeQueue() {
    const add = vi.fn().mockResolvedValue({ id: 'new-job-id' });
    const getJobs = vi.fn().mockResolvedValue([]);
    return { add, getJobs };
}

function makePool(queryImpl?: (sql: string, params?: any[]) => any) {
    const query = vi.fn().mockImplementation(async (sql: string, params?: any[]) => {
        if (queryImpl) return queryImpl(sql, params);
        return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    return { query, connect, release, _rawQuery: query };
}

// ── handleTenantLimitRejection ────────────────────────────────────────────

describe('handleTenantLimitRejection', () => {
    beforeEach(() => {
        delete process.env.TENANT_LIMIT_REQUEUE_DELAY_SEC;
        delete process.env.TENANT_LIMIT_MAX_REQUEUES;
    });

    it('re-enqueues with delay when slot is busy (no throw, fresh attempts)', async () => {
        const pool = makePool();
        const queue = makeQueue();

        const result = await handleTenantLimitRejection(pool as any, queue, {
            jobName: 'dispatch-openclaude',
            jobData: { orgId: ORG, workItemId: WI },
            orgId: ORG,
            workItemId: WI,
        });

        expect(result).toEqual({ action: 'requeued', requeueCount: 1, delaySec: 30 });
        expect(queue.add).toHaveBeenCalledTimes(1);
        const [name, data, opts] = queue.add.mock.calls[0];
        expect(name).toBe('dispatch-openclaude');
        expect((data as any)._tenantLimitRequeues).toBe(1);
        expect(opts).toMatchObject({
            delay: 30_000,
            attempts: 1,
            jobId: `${WI}-requeue-1`,
        });
        // No UPDATE against pool — we only mark blocked on give-up
        expect(pool.query).not.toHaveBeenCalled();
    });

    it('increments the requeue counter across successive rejections', async () => {
        const pool = makePool();
        const queue = makeQueue();

        const result = await handleTenantLimitRejection(pool as any, queue, {
            jobName: 'dispatch-openclaude',
            jobData: { orgId: ORG, workItemId: WI, _tenantLimitRequeues: 5 },
            orgId: ORG,
            workItemId: WI,
        });

        expect(result.requeueCount).toBe(6);
        expect(queue.add).toHaveBeenCalledWith(
            'dispatch-openclaude',
            expect.objectContaining({ _tenantLimitRequeues: 6 }),
            expect.objectContaining({ jobId: `${WI}-requeue-6` }),
        );
    });

    it('marks the work_item blocked after TENANT_LIMIT_MAX_REQUEUES', async () => {
        process.env.TENANT_LIMIT_MAX_REQUEUES = '3';
        const pool = makePool();
        const queue = makeQueue();

        const result = await handleTenantLimitRejection(pool as any, queue, {
            jobName: 'dispatch-openclaude',
            jobData: { orgId: ORG, workItemId: WI, _tenantLimitRequeues: 3 }, // next = 4 > 3
            orgId: ORG,
            workItemId: WI,
        });

        expect(result.action).toBe('blocked');
        expect(queue.add).not.toHaveBeenCalled();
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [sql, params] = pool.query.mock.calls[0];
        expect(sql).toMatch(/UPDATE architect_work_items[\s\S]*SET status = 'blocked'/);
        expect(params![0]).toMatch(/tenant_limit_exhausted after 3 requeues/);
        expect(params![1]).toBe(WI);
    });

    it('honors TENANT_LIMIT_REQUEUE_DELAY_SEC override', async () => {
        process.env.TENANT_LIMIT_REQUEUE_DELAY_SEC = '90';
        const pool = makePool();
        const queue = makeQueue();

        const result = await handleTenantLimitRejection(pool as any, queue, {
            jobName: 'dispatch-openclaude',
            jobData: { orgId: ORG, workItemId: WI },
            orgId: ORG,
            workItemId: WI,
        });

        expect(result.delaySec).toBe(90);
        expect(queue.add).toHaveBeenCalledWith(
            'dispatch-openclaude',
            expect.anything(),
            expect.objectContaining({ delay: 90_000 }),
        );
    });
});

// ── recoverOrphanedPendingWorkItems ───────────────────────────────────────

describe('recoverOrphanedPendingWorkItems', () => {
    beforeEach(() => {
        delete process.env.ARCHITECT_ORPHAN_THRESHOLD_MIN;
        delete process.env.ARCHITECT_MAX_RECOVERY_ATTEMPTS;
    });

    it('re-enqueues orphans that have no live BullMQ job', async () => {
        // 2 candidates; neither is in the live-jobs list → both recovered.
        const candidates = [
            { id: 'a1', org_id: ORG, recovery_attempts: 0 },
            { id: 'b2', org_id: ORG, recovery_attempts: 1 },
        ];
        const pool = makePool((sql) => {
            if (/SELECT id, org_id, recovery_attempts/i.test(sql)) {
                return { rows: candidates, rowCount: candidates.length };
            }
            // Per-row attempt bump
            if (/SET recovery_attempts = recovery_attempts \+ 1/i.test(sql)) {
                return { rows: [], rowCount: 1 };
            }
            // Exhausted-budget UPDATE — pretend nobody hit it in this test
            if (/status = 'blocked'/i.test(sql) && /recovery_attempts >= /i.test(sql)) {
                return { rows: [], rowCount: 0 };
            }
            if (/set_config/i.test(sql)) return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 0 };
        });
        const queue = makeQueue();

        const { recovered, blocked } = await recoverOrphanedPendingWorkItems(
            pool as any,
            queue as any,
        );

        expect(recovered).toBe(2);
        expect(blocked).toBe(0);
        expect(queue.add).toHaveBeenCalledTimes(2);
        expect(queue.add).toHaveBeenCalledWith(
            'dispatch-openclaude',
            { workItemId: 'a1', orgId: ORG },
            expect.objectContaining({ jobId: 'a1-recovery-1', attempts: 1 }),
        );
        expect(queue.add).toHaveBeenCalledWith(
            'dispatch-openclaude',
            { workItemId: 'b2', orgId: ORG },
            expect.objectContaining({ jobId: 'b2-recovery-2', attempts: 1 }),
        );
    });

    it('skips candidates that already have a live BullMQ job', async () => {
        const pool = makePool((sql) => {
            if (/SELECT id, org_id, recovery_attempts/i.test(sql)) {
                return { rows: [{ id: 'x1', org_id: ORG, recovery_attempts: 0 }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        });
        const queue = makeQueue();
        queue.getJobs.mockResolvedValue([{ data: { workItemId: 'x1' } }]);

        const { recovered, blocked } = await recoverOrphanedPendingWorkItems(
            pool as any,
            queue as any,
        );

        expect(recovered).toBe(0);
        expect(blocked).toBe(0);
        expect(queue.add).not.toHaveBeenCalled();
    });

    it('marks items blocked after max recovery attempts', async () => {
        process.env.ARCHITECT_MAX_RECOVERY_ATTEMPTS = '3';
        const pool = makePool((sql) => {
            if (/SELECT id, org_id, recovery_attempts/i.test(sql)) {
                // No fresh candidates — they're all past the attempts threshold.
                return { rows: [], rowCount: 0 };
            }
            if (/status = 'blocked'/i.test(sql) && /recovery_attempts >= /i.test(sql)) {
                return { rows: [], rowCount: 4 }; // pretend 4 items got marked blocked
            }
            return { rows: [], rowCount: 0 };
        });
        const queue = makeQueue();

        const { recovered, blocked } = await recoverOrphanedPendingWorkItems(
            pool as any,
            queue as any,
        );

        expect(recovered).toBe(0);
        expect(blocked).toBe(4);
        expect(queue.add).not.toHaveBeenCalled();
    });
});
