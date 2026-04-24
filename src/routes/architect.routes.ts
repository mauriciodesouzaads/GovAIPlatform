/**
 * Runtime delegation routes
 *
 * ─── FASE 14.0 Etapa 1 ───────────────────────────────────────────────
 * This file used to register 18 workflow routes (cases / demands /
 * contracts / decisions / templates) on top of the 4 delegation
 * routes. The workflow domain was removed in Etapa 1. What stays:
 * the four endpoints that the UI + gRPC adapter layer need to
 * dispatch, cancel, observe and gate work items produced by the
 * [OPENCLAUDE] / [CLAUDE_CODE] / [AIDER] delegation path.
 *
 * Etapa 2 renamed the backing tables (the old delegation table →
 * runtime_work_items, events table similarly) and the BullMQ queue
 * (the old queue → runtime-dispatch). The URL prefix
 * `/v1/admin/architect/work-items/...` is kept as-is to avoid
 * breaking external clients; it's the "architect UX badge" at the
 * API boundary, even though internally everything is "runtime".
 * ─────────────────────────────────────────────────────────────────────
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { dispatchWorkItem } from '../lib/runtime-delegation';
import { runtimeQueue } from '../workers/runtime.worker';

export async function architectRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;

    // ── POST /v1/admin/architect/work-items/:workItemId/dispatch ─────────────
    fastify.post('/v1/admin/architect/work-items/:workItemId/dispatch', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        try {
            // Check execution_hint before dispatching
            const hintCheck = await pgPool.query(
                `SELECT execution_hint FROM runtime_work_items WHERE id = $1`,
                [workItemId]
            );
            const hint = hintCheck.rows[0]?.execution_hint;

            if (hint === 'openclaude') {
                // Async dispatch via BullMQ — returns 202 Accepted immediately
                await runtimeQueue.add('dispatch-openclaude', { orgId, workItemId }, {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5_000 },
                });
                return reply.status(202).send({
                    accepted: true,
                    workItemId,
                    adapter: 'openclaude',
                    message: 'OpenClaude dispatch enqueued. Poll work item status for updates.',
                });
            }

            // Synchronous dispatch for other adapters
            const result = await dispatchWorkItem(pgPool, orgId, workItemId);
            return reply.send(result);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not found')) return reply.status(404).send({ error: msg });
            if (msg.includes('terminal') || msg.includes('blocked') || msg.includes('Max dispatch')) {
                return reply.status(409).send({ error: msg });
            }
            throw err;
        }
    });

    // ── POST /v1/admin/architect/work-items/:workItemId/cancel ───────────────
    // FASE 5-hardening: cancel is now async. We mark cancellation_requested_at,
    // enqueue a `cancel-run` BullMQ job, and let the worker call CancelSignal
    // on the live gRPC stream. cancelled_at is only set after the runner
    // confirms the stream ended (or for items that never started running).
    // Operators drive the chat and therefore own the delegated runs they
    // trigger, so they must be able to cancel them. Admin kept for parity
    // with the other governance surfaces.
    fastify.post('/v1/admin/architect/work-items/:workItemId/cancel', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `UPDATE runtime_work_items
                 SET cancellation_requested_at = NOW()
                 WHERE id = $1 AND org_id = $2
                   AND status IN ('pending', 'in_progress', 'awaiting_approval')
                 RETURNING id, status`,
                [workItemId, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found or not cancellable' });
            }

            await runtimeQueue.add('cancel-run', { orgId, workItemId }, {
                attempts: 1,
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 50 },
            });

            return reply.send({
                cancellation_requested: true,
                workItemId,
                previous_status: result.rows[0].status,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/architect/work-items/:workItemId/events ────────────────
    // FASE 5-hardening: reads from the dedicated runtime_work_item_events
    // table (operational telemetry) instead of evidence_records. Returns the
    // work item state plus the ordered event timeline.
    fastify.get('/v1/admin/architect/work-items/:workItemId/events', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const wi = await client.query(
                `SELECT id, status, execution_hint, title, description, item_type,
                        execution_context, dispatch_attempts, dispatch_error,
                        worker_session_id, worker_runtime, runtime_profile_slug,
                        runtime_claim_level,
                        run_started_at, dispatched_at, last_event_at, cancelled_at,
                        cancellation_requested_at, completed_at, created_at, updated_at
                 FROM runtime_work_items
                 WHERE id = $1 AND org_id = $2`,
                [workItemId, orgId]
            );
            if (wi.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found' });
            }

            const events = await client.query(
                `SELECT id, event_type, event_seq, tool_name, prompt_id, payload, created_at
                 FROM runtime_work_item_events
                 WHERE work_item_id = $1 AND org_id = $2
                 ORDER BY event_seq ASC`,
                [workItemId, orgId]
            );

            // Surface approval_mode as a first-class field so the UI can
            // show the "auto-approval active" badge without reaching into
            // execution_context from TypeScript.
            const workItem = wi.rows[0];
            const approvalMode = workItem.execution_context?.approval_mode ?? null;

            return reply.send({
                work_item: {
                    ...workItem,
                    approval_mode: approvalMode,
                },
                events: events.rows.map(e => ({
                    id: e.id,
                    type: e.event_type,
                    seq: e.event_seq,
                    tool_name: e.tool_name,
                    prompt_id: e.prompt_id,
                    metadata: e.payload,
                    timestamp: e.created_at,
                })),
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/architect/work-items/:workItemId/approve-action ───────
    // FASE 5-hardening: real approval bridge. The work item must be in
    // 'awaiting_approval' state. We enqueue a `resolve-approval` BullMQ job
    // that the architect worker picks up and uses to call respond() on the
    // live gRPC stream registered by the adapter.
    //
    // Approve modes (FASE 6c):
    //   'single'    — default; user approves this one tool call
    //   'auto_all'  — user approves every subsequent tool call on this task
    //   'auto_safe' — user approves every read-only tool; writes still prompt
    //
    // The mode is persisted into execution_context.approval_mode so the
    // adapter's action_required handler can consult it before escalating.
    // Operators who drive the chat own the approval bridge for the tasks
    // they trigger. Without this, the "⚡ Aprovar Todos" click returned
    // 403 for dev@orga.com (operator) and the flow was unreachable from
    // the chat UI.
    fastify.post('/v1/admin/architect/work-items/:workItemId/approve-action', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { orgId, email: actorEmail } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        const body = (request.body ?? {}) as {
            prompt_id?: string;
            approved?: boolean;
            approve_mode?: 'single' | 'auto_all' | 'auto_safe';
        };

        if (!body.prompt_id || typeof body.approved !== 'boolean') {
            return reply.status(400).send({ error: 'prompt_id e approved (boolean) são obrigatórios.' });
        }
        const approveMode: 'single' | 'auto_all' | 'auto_safe' = body.approve_mode ?? 'single';
        if (!['single', 'auto_all', 'auto_safe'].includes(approveMode)) {
            return reply.status(400).send({ error: `approve_mode inválido: ${approveMode}` });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const wi = await client.query(
                `SELECT id, status FROM runtime_work_items WHERE id = $1 AND org_id = $2`,
                [workItemId, orgId]
            );
            if (wi.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found' });
            }
            if (wi.rows[0].status !== 'awaiting_approval') {
                return reply.status(400).send({
                    error: 'Work item not awaiting approval',
                    current_status: wi.rows[0].status,
                });
            }

            // Persist approval_mode on the work item BEFORE enqueueing the
            // resolve-approval job. This guarantees the adapter sees the new
            // mode when the next action_required event fires, because the
            // stream.respond() call happens inside the worker job.
            if (body.approved && approveMode !== 'single') {
                await client.query(
                    `UPDATE runtime_work_items
                     SET execution_context = COALESCE(execution_context, '{}'::jsonb)
                                              || jsonb_build_object('approval_mode', $1::text)
                     WHERE id = $2 AND org_id = $3`,
                    [approveMode, workItemId, orgId]
                );
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await runtimeQueue.add('resolve-approval', {
            orgId,
            workItemId,
            promptId: body.prompt_id,
            approved: body.approved,
            approveMode,
            actorEmail: actorEmail ?? null,
        }, {
            attempts: 1,
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
        });

        return reply.send({
            queued: true,
            workItemId,
            prompt_id: body.prompt_id,
            approved: body.approved,
            approve_mode: approveMode,
        });
    });
}
