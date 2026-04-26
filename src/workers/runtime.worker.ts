/**
 * Runtime Dispatch BullMQ Worker — renamed from architect.worker in
 * FASE 14.0/2. The three job types stay the same; the queue name moved
 * from `the old queue` to `runtime-dispatch` to match the domain
 * nomenclature established after the Arquiteto-workflow removal.
 *
 * Job types on the `runtime-dispatch` queue:
 *
 *   - dispatch-openclaude  : start an OpenClaude run for a work item
 *                            (long-lived; lock held until the gRPC stream
 *                            terminates or hits the worker lock duration)
 *   - cancel-run           : send CancelSignal on a live stream
 *   - resolve-approval     : forward UserInput on a stream that is suspended
 *                            in awaiting_approval state
 *
 * Stream registry: an in-memory Map keyed by work_item_id holds cancel() /
 * respond() handles published by the adapter when it starts the run. Both
 * cancel-run and resolve-approval read from it. The map is process-local —
 * for multi-instance deployments, see comments in runtime-stream-registry.ts.
 *
 * Concurrency: 2 (max 2 simultaneous OpenClaude runs per API instance).
 * lockDuration: 1 hour (must exceed worst-case approval wait + run time).
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import {
    dispatchWorkItem,
    detectAndMarkStuckWorkItems,
    recoverOrphanedPendingWorkItems,
} from '../lib/runtime-delegation';
import { getStream } from '../lib/runtime-stream-registry';
import { publishControl } from '../lib/runtime-stream-registry-redis';
import { cleanupOrphanedWorkspaces } from '../lib/workspace-manager';
import { recordEvidence } from '../lib/evidence';
import { acquireTenantSlot, releaseTenantSlot } from '../lib/tenant-concurrency';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const runtimeQueue = new Queue('runtime-dispatch', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
    },
});

export interface RuntimeDispatchPayload {
    orgId: string;
    workItemId: string;
    /** FASE 13.5a1 — internal counter bumped each time a TENANT_LIMIT
     *  rejection re-enqueues the job. NOT set by external callers. */
    _tenantLimitRequeues?: number;
}

/**
 * FASE 13.5a1 — handle a tenant-slot busy rejection without consuming
 * BullMQ's retry budget. Either re-enqueues with a configurable delay,
 * or (after `maxRequeues`) marks the work_item as `blocked` with a
 * clear reason. Exported for unit testing in isolation.
 *
 * Behavior:
 *   - `requeueCount = prev + 1`; if it exceeds `maxRequeues`, UPDATE
 *     runtime_work_items.status = 'blocked' + dispatch_error
 *   - otherwise, call `queue.add(jobName, {...job.data, _tenantLimitRequeues: requeueCount}, {delay, attempts:1, jobId})`
 *   - NEVER throws from a healthy path — the caller's consumer should
 *     `return` immediately after this resolves.
 */
export async function handleTenantLimitRejection(
    pool: Pool,
    queue: { add: (name: string, data: any, opts: any) => Promise<unknown> },
    args: {
        jobName: string;
        jobData: RuntimeDispatchPayload;
        orgId: string;
        workItemId: string;
    },
): Promise<{ action: 'requeued' | 'blocked'; requeueCount: number; delaySec: number }> {
    const delaySec = parseInt(process.env.TENANT_LIMIT_REQUEUE_DELAY_SEC || '30', 10);
    const maxRequeues = parseInt(process.env.TENANT_LIMIT_MAX_REQUEUES || '40', 10);
    const prevRequeues = Number(args.jobData._tenantLimitRequeues ?? 0);
    const requeueCount = prevRequeues + 1;

    if (requeueCount > maxRequeues) {
        const approxMin = Math.round((maxRequeues * delaySec) / 60);
        try {
            await pool.query(
                `UPDATE runtime_work_items
                    SET status = 'blocked',
                        dispatch_error = $1,
                        last_event_at = NOW()
                  WHERE id = $2 AND status = 'pending'`,
                [
                    `tenant_limit_exhausted after ${maxRequeues} requeues (~${approxMin}min)`,
                    args.workItemId,
                ],
            );
        } catch (err) {
            console.warn(
                '[Runtime Worker] failed to mark blocked:',
                (err as Error).message,
            );
        }
        console.warn(
            `[Runtime Worker] work_item ${args.workItemId} BLOCKED: tenant_limit_exhausted`,
        );
        return { action: 'blocked', requeueCount, delaySec };
    }

    console.log(
        `[Runtime Worker] tenant ${args.orgId} at concurrency limit, ` +
        `re-queuing work_item ${args.workItemId} in ${delaySec}s ` +
        `(requeue ${requeueCount}/${maxRequeues})`,
    );
    await queue.add(
        args.jobName,
        { ...args.jobData, _tenantLimitRequeues: requeueCount },
        {
            delay: delaySec * 1000,
            attempts: 1,
            jobId: `${args.workItemId}-requeue-${requeueCount}`,
            removeOnComplete: true,
            removeOnFail: { age: 3600, count: 100 },
        },
    );
    return { action: 'requeued', requeueCount, delaySec };
}

export interface CancelRunPayload {
    orgId: string;
    workItemId: string;
}

export interface ResolveApprovalPayload {
    orgId: string;
    workItemId: string;
    promptId: string;
    approved: boolean;
    /** 'single' approves only this tool; 'auto_all' approves every subsequent;
     *  'auto_safe' approves read-only tools automatically and prompts on writes. */
    approveMode?: 'single' | 'auto_all' | 'auto_safe';
    actorEmail?: string;
}

type RuntimeJobPayload =
    | RuntimeDispatchPayload
    | CancelRunPayload
    | ResolveApprovalPayload;

export function initRuntimeWorker(pgPool: Pool): Worker {
    // Garbage-collect any workspaces left behind by previous boots before
    // we start accepting new jobs.
    try {
        cleanupOrphanedWorkspaces();
    } catch (err) {
        console.warn('[Runtime Worker] Workspace GC failed:', (err as Error).message);
    }

    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any;

    const worker = new Worker<RuntimeJobPayload>(
        'runtime-dispatch',
        async (job: Job<RuntimeJobPayload>) => {
            // ── cancel-run ────────────────────────────────────────────────
            if (job.name === 'cancel-run') {
                const { orgId, workItemId } = job.data as CancelRunPayload;
                console.log(`[Runtime Worker] cancel-run for ${workItemId}`);

                // FASE 9: try local stream first; if not found and distributed
                // mode is enabled, broadcast via Redis pub/sub to all replicas.
                const stream = getStream(workItemId);
                if (stream) {
                    try { stream.cancel(); } catch (err) {
                        console.warn(`[Runtime Worker] cancel() threw:`, (err as Error).message);
                    }
                } else if (process.env.STREAM_REGISTRY_MODE !== 'local') {
                    try {
                        await publishControl({ type: 'cancel', workItemId });
                        console.log(`[Runtime Worker] published cancel via pub/sub for ${workItemId}`);
                    } catch (err) {
                        console.warn(`[Runtime Worker] publishControl(cancel) failed:`, (err as Error).message);
                    }
                }

                // Mark cancelled in DB if still pending — the stream's error handler
                // will set cancelled_at when the gRPC end arrives. For pending items
                // (never started) we mark cancelled directly here.
                const cl = await pgPool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    await cl.query(
                        `UPDATE runtime_work_items
                         SET status = 'cancelled', cancelled_at = NOW()
                         WHERE id = $1 AND org_id = $2
                           AND status IN ('pending', 'awaiting_approval')`,
                        [workItemId, orgId]
                    );
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }

                await recordEvidence(pgPool, {
                    orgId,
                    category: 'data_access',
                    eventType: 'OPENCLAUDE_RUN_CANCELLED',
                    resourceType: 'runtime_work_item',
                    resourceId: workItemId,
                    metadata: { source: 'cancel-run-job', hadActiveStream: Boolean(stream) },
                }).catch(() => {});

                return { cancelled: true, hadStream: Boolean(stream) };
            }

            // ── resolve-approval ──────────────────────────────────────────
            if (job.name === 'resolve-approval') {
                const { orgId, workItemId, promptId, approved, approveMode, actorEmail } = job.data as ResolveApprovalPayload;
                const mode = approveMode ?? 'single';
                console.log(`[Runtime Worker] resolve-approval for ${workItemId} promptId=${promptId} approved=${approved} mode=${mode}`);

                // FASE 9: try local stream first; if not found and distributed
                // mode is enabled, broadcast via Redis pub/sub.
                const stream = getStream(workItemId);
                if (stream) {
                    try {
                        stream.respond(promptId, approved ? 'yes' : 'no');
                    } catch (err) {
                        console.warn(`[Runtime Worker] respond() threw:`, (err as Error).message);
                        return { resolved: false, reason: 'respond_failed' };
                    }
                } else if (process.env.STREAM_REGISTRY_MODE !== 'local') {
                    try {
                        await publishControl({
                            type: 'respond',
                            workItemId,
                            promptId,
                            reply: approved ? 'yes' : 'no',
                        });
                        console.log(`[Runtime Worker] published respond via pub/sub for ${workItemId} promptId=${promptId}`);
                    } catch (err) {
                        console.warn(`[Runtime Worker] publishControl(respond) failed:`, (err as Error).message);
                        return { resolved: false, reason: 'publish_failed' };
                    }
                } else {
                    console.warn(`[Runtime Worker] resolve-approval: no active stream for ${workItemId} (local mode)`);
                    return { resolved: false, reason: 'no_active_stream' };
                }

                // FASE 6c: OpenClaude can emit multiple ACTION_REQUIRED events
                // in parallel (one per concurrent tool call). A single respond()
                // only unblocks one pending Promise on the server side; the rest
                // stay stuck. When the user picks auto_all we must broadcast a
                // respond() to every outstanding pending prompt so the whole
                // work item unblocks in one shot.
                if (approved && mode === 'auto_all') {
                    try {
                        const other = await pgPool.connect();
                        try {
                            await other.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                            const pendingRes = await other.query(
                                `SELECT DISTINCT e.prompt_id
                                 FROM runtime_work_item_events e
                                 WHERE e.work_item_id = $1
                                   AND e.org_id = $2
                                   AND e.event_type = 'ACTION_REQUIRED'
                                   AND e.prompt_id IS NOT NULL
                                   AND e.prompt_id <> $3
                                   AND NOT EXISTS (
                                       SELECT 1 FROM runtime_work_item_events r
                                       WHERE r.work_item_id = e.work_item_id
                                         AND r.org_id = e.org_id
                                         AND r.event_type = 'ACTION_RESPONSE'
                                         AND r.prompt_id = e.prompt_id
                                   )`,
                                [workItemId, orgId, promptId]
                            );
                            for (const row of pendingRes.rows) {
                                const otherPromptId = row.prompt_id as string;
                                try {
                                    // FASE 9: use local stream if available,
                                    // otherwise broadcast via pub/sub.
                                    if (stream) {
                                        stream.respond(otherPromptId, 'yes');
                                    } else if (process.env.STREAM_REGISTRY_MODE !== 'local') {
                                        await publishControl({ type: 'respond', workItemId, promptId: otherPromptId, reply: 'yes' });
                                    }
                                    console.log(`[Runtime Worker] auto_all broadcast respond for ${otherPromptId}`);
                                    await other.query(
                                        `INSERT INTO runtime_work_item_events
                                            (org_id, work_item_id, event_type, event_seq, tool_name, prompt_id, payload)
                                         VALUES (
                                            $1, $2, 'ACTION_RESPONSE',
                                            COALESCE((SELECT MAX(event_seq) + 1 FROM runtime_work_item_events WHERE work_item_id = $2), 1),
                                            NULL, $3,
                                            '{"decision":"allow","reason":"user_approved_all_broadcast","automatic":true}'::jsonb
                                         )`,
                                        [orgId, workItemId, otherPromptId]
                                    );
                                } catch (e) {
                                    console.warn('[Runtime Worker] auto_all broadcast respond failed:', (e as Error).message);
                                }
                            }
                        } finally {
                            await other.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                            other.release();
                        }
                    } catch (e) {
                        console.warn('[Runtime Worker] auto_all broadcast failed:', (e as Error).message);
                    }
                }

                // Flip the work item back to in_progress so the UI reflects the resume.
                // Also belt-and-suspenders persist approval_mode here in case the route
                // raced or a retry happened — the UPDATE is idempotent.
                const cl = await pgPool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    if (approved && mode !== 'single') {
                        await cl.query(
                            `UPDATE runtime_work_items
                             SET status = 'in_progress', last_event_at = NOW(),
                                 execution_context = COALESCE(execution_context, '{}'::jsonb)
                                                      || jsonb_build_object('approval_mode', $3::text)
                             WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval'`,
                            [workItemId, orgId, mode]
                        );
                    } else {
                        await cl.query(
                            `UPDATE runtime_work_items
                             SET status = 'in_progress', last_event_at = NOW()
                             WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval'`,
                            [workItemId, orgId]
                        );
                    }
                } finally {
                    await cl.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    cl.release();
                }

                await recordEvidence(pgPool, {
                    orgId,
                    category: 'approval',
                    eventType: approved ? 'TOOL_APPROVED_BY_HUMAN' : 'TOOL_REJECTED_BY_HUMAN',
                    resourceType: 'runtime_work_item',
                    resourceId: workItemId,
                    actorEmail: actorEmail ?? null,
                    metadata: { promptId, approved, approveMode: mode },
                }).catch(() => {});

                return { resolved: true, approved, approveMode: mode };
            }

            // ── dispatch-openclaude (default) ─────────────────────────────
            const { orgId, workItemId } = job.data as RuntimeDispatchPayload;
            console.log(`[Runtime Worker] Dispatching work item ${workItemId} for org ${orgId}`);

            // FASE 11: per-tenant concurrency — block if this tenant is at
            // capacity so no single org starves the global 2-slot worker.
            //
            // FASE 13.5a1 (hotfix): when the slot is busy, re-enqueue as a
            // NEW job with a fresh attempts budget instead of throwing.
            // The previous `throw new Error('TENANT_LIMIT')` was fatal
            // in practice: BullMQ's retry budget is 3, exponential backoff
            // 5s/10s/20s = ~35s, and while the first run holds the slot for
            // 60-180s (especially when routed through a rate-limited
            // provider like Gemini free-tier), the retries stack up and the
            // job is DROPPED before the slot releases, orphaning the
            // work_item in status='pending' forever.
            //
            // See docs/DIAGNOSTIC_RUNTIME_HANG_20260422.md + ADR-021.
            const hasSlot = await acquireTenantSlot(orgId);
            if (!hasSlot) {
                await handleTenantLimitRejection(pgPool, runtimeQueue, {
                    jobName: job.name,
                    jobData: job.data as RuntimeDispatchPayload,
                    orgId,
                    workItemId,
                });
                return; // graceful — do NOT throw
            }

            try {
                const result = await dispatchWorkItem(pgPool, orgId, workItemId);
                console.log(`[Runtime Worker] Completed: adapter=${result.adapter} success=${result.success}`);
                return result;
            } finally {
                await releaseTenantSlot(orgId);
            }
        },
        {
            connection,
            concurrency: 2,
            // 1 hour lock — approvals can take time, and the adapter holds the
            // job promise open for the lifetime of the gRPC stream.
            lockDuration: 60 * 60 * 1000,
        }
    );

    worker.on('completed', (job) => {
        console.log(`[Runtime Worker] Job ${job.id} (${job.name}) completed`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Runtime Worker] Job ${job?.id} (${job?.name}) failed: ${err?.message}`);
    });

    worker.on('error', (err) => {
        console.error(`[Runtime Worker] Worker error:`, err?.message);
    });

    // ── FASE 11: Periodic watchdog + workspace cleanup ──────────────────
    // Watchdog: every 5 min, mark work items stuck > 15 min as blocked,
    // AND (FASE 13.5a1) re-dispatch orphaned PENDING items whose BullMQ
    // job was dropped (e.g., TENANT_LIMIT retries exhausted). Operators see
    // dispatch_error with "Stuck for N minutes" (stuck) or
    // "watchdog_recovery_exhausted" (orphan that couldn't be recovered).
    const watchdogInterval = setInterval(async () => {
        try {
            const marked = await detectAndMarkStuckWorkItems(pgPool);
            if (marked > 0) {
                console.log(`[Runtime Watchdog] Marked ${marked} stuck work items as blocked`);
            }
        } catch (err) {
            console.warn('[Runtime Watchdog] sweep error:', (err as Error).message);
        }
        try {
            const { recovered, blocked } = await recoverOrphanedPendingWorkItems(
                pgPool,
                runtimeQueue as unknown as Parameters<typeof recoverOrphanedPendingWorkItems>[1],
            );
            if (recovered > 0) {
                console.log(`[Runtime Watchdog] Recovered ${recovered} orphaned PENDING work items`);
            }
            if (blocked > 0) {
                console.warn(`[Runtime Watchdog] Blocked ${blocked} work items after recovery budget exhausted`);
            }
        } catch (err) {
            console.warn('[Runtime Watchdog] orphan recovery error:', (err as Error).message);
        }
    }, 5 * 60 * 1000);

    // Workspace cleanup: every 30 min, garbage-collect orphaned dirs.
    // Complements the on-boot cleanup so long-running processes don't
    // leak disk over time.
    const workspaceCleanupInterval = setInterval(() => {
        try {
            const cleaned = cleanupOrphanedWorkspaces();
            if (cleaned > 0) {
                console.log(`[Workspace Cron] Cleaned ${cleaned} orphaned workspaces`);
            }
        } catch (err) {
            console.warn('[Workspace Cron] error:', (err as Error).message);
        }
    }, 30 * 60 * 1000);

    // BLOCO 2: final cleanup on graceful shutdown
    const shutdownRuntime = async () => {
        console.log('[Runtime Worker] Shutdown — running final workspace cleanup');
        clearInterval(watchdogInterval);
        clearInterval(workspaceCleanupInterval);
        try {
            const cleaned = cleanupOrphanedWorkspaces();
            if (cleaned > 0) console.log(`[Runtime Worker] Final cleanup: ${cleaned} workspaces`);
        } catch (err) {
            console.warn('[Runtime Worker] cleanup error on shutdown:', (err as Error).message);
        }
        try { await worker.close(); } catch { /* ignore */ }
    };
    process.once('SIGTERM', shutdownRuntime);
    process.once('SIGINT', shutdownRuntime);

    console.log('[Runtime Worker] Started (watchdog=5min, workspace cleanup=30min)');
    return worker;
}
