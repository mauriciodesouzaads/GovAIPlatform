/**
 * Architect BullMQ Worker
 *
 * Handles three job types on the `architect-dispatch` queue:
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
 * for multi-instance deployments, see comments in architect-stream-registry.ts.
 *
 * Concurrency: 2 (max 2 simultaneous OpenClaude runs per API instance).
 * lockDuration: 1 hour (must exceed worst-case approval wait + run time).
 */

import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Pool } from 'pg';
import { dispatchWorkItem } from '../lib/architect-delegation';
import { getStream } from '../lib/architect-stream-registry';
import { cleanupOrphanedWorkspaces } from '../lib/workspace-manager';
import { recordEvidence } from '../lib/evidence';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const architectQueue = new Queue('architect-dispatch', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
    },
});

export interface ArchitectDispatchPayload {
    orgId: string;
    workItemId: string;
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

type ArchitectJobPayload =
    | ArchitectDispatchPayload
    | CancelRunPayload
    | ResolveApprovalPayload;

export function initArchitectWorker(pgPool: Pool): Worker {
    // Garbage-collect any workspaces left behind by previous boots before
    // we start accepting new jobs.
    try {
        cleanupOrphanedWorkspaces();
    } catch (err) {
        console.warn('[Architect Worker] Workspace GC failed:', (err as Error).message);
    }

    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any;

    const worker = new Worker<ArchitectJobPayload>(
        'architect-dispatch',
        async (job: Job<ArchitectJobPayload>) => {
            // ── cancel-run ────────────────────────────────────────────────
            if (job.name === 'cancel-run') {
                const { orgId, workItemId } = job.data as CancelRunPayload;
                console.log(`[Architect Worker] cancel-run for ${workItemId}`);

                const stream = getStream(workItemId);
                if (stream) {
                    try { stream.cancel(); } catch (err) {
                        console.warn(`[Architect Worker] cancel() threw:`, (err as Error).message);
                    }
                }

                // Mark cancelled in DB if still pending — the stream's error handler
                // will set cancelled_at when the gRPC end arrives. For pending items
                // (never started) we mark cancelled directly here.
                const cl = await pgPool.connect();
                try {
                    await cl.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    await cl.query(
                        `UPDATE architect_work_items
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
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    metadata: { source: 'cancel-run-job', hadActiveStream: Boolean(stream) },
                }).catch(() => {});

                return { cancelled: true, hadStream: Boolean(stream) };
            }

            // ── resolve-approval ──────────────────────────────────────────
            if (job.name === 'resolve-approval') {
                const { orgId, workItemId, promptId, approved, approveMode, actorEmail } = job.data as ResolveApprovalPayload;
                const mode = approveMode ?? 'single';
                console.log(`[Architect Worker] resolve-approval for ${workItemId} promptId=${promptId} approved=${approved} mode=${mode}`);

                const stream = getStream(workItemId);
                if (!stream) {
                    console.warn(`[Architect Worker] resolve-approval: no active stream for ${workItemId}`);
                    return { resolved: false, reason: 'no_active_stream' };
                }

                try {
                    stream.respond(promptId, approved ? 'yes' : 'no');
                } catch (err) {
                    console.warn(`[Architect Worker] respond() threw:`, (err as Error).message);
                    return { resolved: false, reason: 'respond_failed' };
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
                                 FROM architect_work_item_events e
                                 WHERE e.work_item_id = $1
                                   AND e.org_id = $2
                                   AND e.event_type = 'ACTION_REQUIRED'
                                   AND e.prompt_id IS NOT NULL
                                   AND e.prompt_id <> $3
                                   AND NOT EXISTS (
                                       SELECT 1 FROM architect_work_item_events r
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
                                    stream.respond(otherPromptId, 'yes');
                                    console.log(`[Architect Worker] auto_all broadcast respond for ${otherPromptId}`);
                                    await other.query(
                                        `INSERT INTO architect_work_item_events
                                            (org_id, work_item_id, event_type, event_seq, tool_name, prompt_id, payload)
                                         VALUES (
                                            $1, $2, 'ACTION_RESPONSE',
                                            COALESCE((SELECT MAX(event_seq) + 1 FROM architect_work_item_events WHERE work_item_id = $2), 1),
                                            NULL, $3,
                                            '{"decision":"allow","reason":"user_approved_all_broadcast","automatic":true}'::jsonb
                                         )`,
                                        [orgId, workItemId, otherPromptId]
                                    );
                                } catch (e) {
                                    console.warn('[Architect Worker] auto_all broadcast respond failed:', (e as Error).message);
                                }
                            }
                        } finally {
                            await other.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                            other.release();
                        }
                    } catch (e) {
                        console.warn('[Architect Worker] auto_all broadcast failed:', (e as Error).message);
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
                            `UPDATE architect_work_items
                             SET status = 'in_progress', last_event_at = NOW(),
                                 execution_context = COALESCE(execution_context, '{}'::jsonb)
                                                      || jsonb_build_object('approval_mode', $3::text)
                             WHERE id = $1 AND org_id = $2 AND status = 'awaiting_approval'`,
                            [workItemId, orgId, mode]
                        );
                    } else {
                        await cl.query(
                            `UPDATE architect_work_items
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
                    resourceType: 'architect_work_item',
                    resourceId: workItemId,
                    actorEmail: actorEmail ?? null,
                    metadata: { promptId, approved, approveMode: mode },
                }).catch(() => {});

                return { resolved: true, approved, approveMode: mode };
            }

            // ── dispatch-openclaude (default) ─────────────────────────────
            const { orgId, workItemId } = job.data as ArchitectDispatchPayload;
            console.log(`[Architect Worker] Dispatching work item ${workItemId} for org ${orgId}`);

            const result = await dispatchWorkItem(pgPool, orgId, workItemId);
            console.log(`[Architect Worker] Completed: adapter=${result.adapter} success=${result.success}`);
            return result;
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
        console.log(`[Architect Worker] Job ${job.id} (${job.name}) completed`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[Architect Worker] Job ${job?.id} (${job?.name}) failed: ${err?.message}`);
    });

    worker.on('error', (err) => {
        console.error(`[Architect Worker] Worker error:`, err?.message);
    });

    console.log('[Architect Worker] Started');
    return worker;
}
