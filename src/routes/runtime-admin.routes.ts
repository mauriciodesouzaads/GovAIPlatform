/**
 * Runtime Admin API — FASE 14.0/5a
 * ---------------------------------------------------------------------------
 * Foundation for the /execucoes admin panel. Etapa 5b consumes the
 * endpoints registered here. Legacy /v1/admin/architect/* survives
 * untouched so the playground (its only consumer) keeps working until
 * 5b finishes the cutover.
 *
 * Endpoints (all under /v1/admin/runtime):
 *   GET    /work-items                  — paginated list with filters
 *   GET    /work-items/:id              — detail + events + child subagents
 *   GET    /work-items/:id/events/stream — SSE live tail (polling backend)
 *   POST   /work-items/:id/cancel       — graceful cancel (BullMQ job)
 *   GET    /sessions                    — claude-code session index from Redis
 *   GET    /runners/health              — per-runtime availability + transport
 *
 * Conventions:
 *   - Auth via JWT preHandler. Org isolation via app.current_org_id +
 *     RLS policies on runtime_work_items / runtime_work_item_events.
 *   - Filters validated by zod; bad input → 400 with details.
 *   - Cursor pagination via (created_at, id) tiebreaker.
 *   - SSE follows the chat.routes.ts pattern (reply.hijack +
 *     buildCorsHeaders) so ADR-022 cors-on-hijacked-sse compliance is
 *     automatic.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { redisCache } from '../lib/redis';
import { buildCorsHeaders } from '../lib/cors-config';
import {
    listRuntimeProfiles,
    isRuntimeAvailableCached,
    resolveRuntimeTarget,
    RuntimeProfile,
} from '../lib/runtime-profiles';
import type {
    RuntimeWorkItemSummary,
    RuntimeWorkItemEvent,
    RuntimeWorkItemListResponse,
    RuntimeWorkItemDetailResponse,
    RuntimeSession,
    RuntimeSessionListResponse,
    RuntimeRunnerHealth,
    RuntimeRunnerHealthResponse,
} from '../types/runtime-admin';

// ── Validation schemas ──────────────────────────────────────────────────────

const STATUS_SET = ['pending', 'in_progress', 'awaiting_approval', 'done', 'blocked', 'cancelled'] as const;

const listQuerySchema = z.object({
    /** comma-separated; we split here to keep shape simple in the URL. */
    status: z.string().optional(),
    runtime_profile_slug: z.string().min(1).max(100).optional(),
    parent_work_item_id: z.union([
        z.string().uuid(),
        z.literal('null'),  // top-level only
    ]).optional(),
    session_id: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().uuid().optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseStatusList(raw: string | undefined): string[] | null {
    if (!raw) return null;
    const out = raw.split(',').map(s => s.trim()).filter(Boolean);
    const invalid = out.filter(s => !(STATUS_SET as readonly string[]).includes(s));
    if (invalid.length > 0) {
        throw new Error(`invalid status value(s): ${invalid.join(', ')}`);
    }
    return out;
}

interface RowToSummary {
    id: string;
    status: string;
    runtime_profile_slug: string | null;
    title: string;
    description: string | null;
    parent_work_item_id: string | null;
    subagent_depth: number;
    worker_session_id: string | null;
    session_id: string | null;
    created_at: Date;
    completed_at: Date | null;
    dispatch_error: string | null;
    tool_count: string | number;
    event_count: string | number;
    tokens: any;
}

function rowToSummary(r: RowToSummary): RuntimeWorkItemSummary {
    const tokens = r.tokens && typeof r.tokens === 'object'
        ? {
            prompt: Number(r.tokens.prompt ?? 0),
            completion: Number(r.tokens.completion ?? 0),
        }
        : null;
    return {
        id: r.id,
        status: r.status as RuntimeWorkItemSummary['status'],
        runtime_profile_slug: r.runtime_profile_slug,
        title: r.title,
        description: r.description,
        parent_work_item_id: r.parent_work_item_id,
        subagent_depth: r.subagent_depth ?? 0,
        worker_session_id: r.worker_session_id,
        session_id: r.session_id,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        completed_at: r.completed_at
            ? (r.completed_at instanceof Date ? r.completed_at.toISOString() : String(r.completed_at))
            : null,
        dispatch_error: r.dispatch_error,
        tool_count: Number(r.tool_count ?? 0),
        event_count: Number(r.event_count ?? 0),
        tokens,
        has_error: r.status === 'failed' || r.status === 'blocked' || Boolean(r.dispatch_error),
    };
}

const SUMMARY_SELECT = `
    SELECT
        wi.id, wi.status, wi.runtime_profile_slug, wi.title, wi.description,
        wi.parent_work_item_id, wi.subagent_depth, wi.worker_session_id,
        wi.session_id, wi.created_at, wi.completed_at, wi.dispatch_error,
        (SELECT COUNT(*) FROM runtime_work_item_events e
            WHERE e.work_item_id = wi.id
              AND e.event_type IN ('TOOL_START', 'TOOL_RESULT')) AS tool_count,
        (SELECT COUNT(*) FROM runtime_work_item_events e
            WHERE e.work_item_id = wi.id) AS event_count,
        (wi.execution_context->'tokens') AS tokens
    FROM runtime_work_items wi
`;

// ────────────────────────────────────────────────────────────────────────────

export async function runtimeAdminRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;
    const readAuth  = requireRole(['admin', 'operator', 'dpo', 'auditor']);
    const writeAuth = requireRole(['admin', 'operator']);

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/admin/runtime/work-items
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/admin/runtime/work-items', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const parse = listQuerySchema.safeParse(request.query);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid query', details: parse.error.format() });
        }
        const q = parse.data;

        let statusList: string[] | null;
        try { statusList = parseStatusList(q.status); }
        catch (err: any) {
            return reply.status(400).send({ error: err.message });
        }

        const params: any[] = [orgId];
        const where: string[] = ['wi.org_id = $1'];

        if (statusList && statusList.length > 0) {
            params.push(statusList);
            where.push(`wi.status = ANY($${params.length}::text[])`);
        }
        if (q.runtime_profile_slug) {
            params.push(q.runtime_profile_slug);
            where.push(`wi.runtime_profile_slug = $${params.length}`);
        }
        if (q.parent_work_item_id) {
            if (q.parent_work_item_id === 'null') {
                where.push('wi.parent_work_item_id IS NULL');
            } else {
                params.push(q.parent_work_item_id);
                where.push(`wi.parent_work_item_id = $${params.length}::uuid`);
            }
        }
        if (q.session_id) {
            params.push(q.session_id);
            where.push(`wi.session_id = $${params.length}::uuid`);
        }
        if (q.since) {
            params.push(q.since);
            where.push(`wi.created_at >= $${params.length}::timestamptz`);
        }
        if (q.until) {
            params.push(q.until);
            where.push(`wi.created_at <= $${params.length}::timestamptz`);
        }

        // Cursor pagination uses (created_at, id) so rows with identical
        // created_at don't get skipped or duplicated. The cursor encodes
        // the LAST row of the previous page; we look it up to read its
        // created_at, then filter strictly less-than.
        if (q.cursor) {
            params.push(q.cursor);
            where.push(`(wi.created_at, wi.id) <
                        (SELECT created_at, id FROM runtime_work_items
                          WHERE id = $${params.length}::uuid)`);
        }

        const limitPlusOne = q.limit + 1;
        params.push(limitPlusOne);

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const sql = `
                ${SUMMARY_SELECT}
                WHERE ${where.join(' AND ')}
                ORDER BY wi.created_at DESC, wi.id DESC
                LIMIT $${params.length}
            `;
            const res = await client.query(sql, params);

            // total_estimate via pg_class.reltuples is too coarse for
            // filtered queries; we compute an exact count when the
            // result set is small (cheap) and fall back to null
            // otherwise so the UI can render "many" without a hot
            // count over the whole table on every page-flip.
            let totalEstimate: number | null = null;
            if (res.rows.length < limitPlusOne) {
                // result fits in one page → exact count is the page size
                totalEstimate = res.rows.length;
            } else {
                const countParams = params.slice(0, -1);  // drop limit
                // we also exclude the cursor predicate from the count to
                // give the UI the total matching the filter, not just
                // "after this cursor".
                const cursorIdx = q.cursor ? countParams.length : -1;
                if (cursorIdx >= 0) countParams.pop();
                const whereForCount = where.slice(0, q.cursor ? -1 : undefined);
                const countSql = `SELECT COUNT(*) AS n FROM runtime_work_items wi WHERE ${whereForCount.join(' AND ')}`;
                try {
                    const c = await client.query(countSql, countParams);
                    totalEstimate = Number(c.rows[0]?.n ?? 0);
                } catch { /* best-effort */ }
            }

            const rows = res.rows.slice(0, q.limit);
            const items = rows.map(rowToSummary);
            const nextCursor = res.rows.length > q.limit
                ? rows[rows.length - 1]?.id ?? null
                : null;

            const body: RuntimeWorkItemListResponse = {
                items,
                next_cursor: nextCursor,
                total_estimate: totalEstimate,
            };
            return reply.send(body);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/admin/runtime/work-items/:id
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/admin/runtime/work-items/:id', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return reply.status(400).send({ error: 'invalid id (uuid expected)' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const wiRes = await client.query(
                `${SUMMARY_SELECT}
                 WHERE wi.id = $1::uuid AND wi.org_id = $2`,
                [id, orgId]
            );
            if (wiRes.rows.length === 0) {
                return reply.status(404).send({ error: 'work_item not found' });
            }
            const summary = rowToSummary(wiRes.rows[0]);

            // Pull the rest of the columns the detail view needs separately.
            // (Avoiding a 30-column SELECT in SUMMARY_SELECT keeps the list
            // route narrow.)
            const fullRes = await client.query(
                `SELECT execution_context, execution_hint, worker_runtime,
                        runtime_claim_level, dispatch_attempts, recovery_attempts,
                        run_started_at, cancelled_at, cancellation_requested_at,
                        last_event_at, mcp_server_ids
                   FROM runtime_work_items
                  WHERE id = $1::uuid AND org_id = $2`,
                [id, orgId]
            );
            const full = fullRes.rows[0] || {};

            const eventsRes = await client.query(
                `SELECT id, event_seq AS seq, event_type AS type,
                        tool_name, prompt_id, payload, created_at
                   FROM runtime_work_item_events
                  WHERE work_item_id = $1::uuid AND org_id = $2
                  ORDER BY event_seq ASC`,
                [id, orgId]
            );
            const events: RuntimeWorkItemEvent[] = eventsRes.rows.map(e => ({
                id: e.id,
                seq: Number(e.seq),
                type: e.type,
                tool_name: e.tool_name,
                prompt_id: e.prompt_id,
                payload: e.payload || {},
                timestamp: e.created_at instanceof Date
                    ? e.created_at.toISOString()
                    : String(e.created_at),
            }));

            const subRes = await client.query(
                `${SUMMARY_SELECT}
                 WHERE wi.parent_work_item_id = $1::uuid AND wi.org_id = $2
                 ORDER BY wi.created_at ASC`,
                [id, orgId]
            );
            const subagents = subRes.rows.map(rowToSummary);

            const body: RuntimeWorkItemDetailResponse = {
                work_item: {
                    ...summary,
                    execution_context: full.execution_context || {},
                    execution_hint: full.execution_hint,
                    worker_runtime: full.worker_runtime || 'internal',
                    runtime_claim_level: full.runtime_claim_level,
                    dispatch_attempts: Number(full.dispatch_attempts ?? 0),
                    recovery_attempts: Number(full.recovery_attempts ?? 0),
                    run_started_at: full.run_started_at
                        ? full.run_started_at.toISOString() : null,
                    cancelled_at: full.cancelled_at
                        ? full.cancelled_at.toISOString() : null,
                    cancellation_requested_at: full.cancellation_requested_at
                        ? full.cancellation_requested_at.toISOString() : null,
                    last_event_at: full.last_event_at
                        ? full.last_event_at.toISOString() : null,
                    mcp_server_ids: Array.isArray(full.mcp_server_ids)
                        ? full.mcp_server_ids : null,
                },
                events,
                subagents,
            };
            return reply.send(body);
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/admin/runtime/work-items/:id/events/stream  (SSE)
    // ──────────────────────────────────────────────────────────────────
    //
    // Live tail. Polls the events table every POLL_MS for rows with
    // event_seq > lastSeq and writes one SSE message per row. Closes
    // the stream when the work_item reaches a terminal status OR
    // when MAX_DURATION_MS elapses, whichever comes first.
    //
    // Polling vs LISTEN/NOTIFY: 500ms polling is enough for human-
    // facing UIs (timelines update twice per second). LISTEN/NOTIFY
    // is left as a future optimization — the migration would add a
    // trigger on insert to NOTIFY a per-work-item channel.
    //
    // Limits:
    //   - Max 5 minutes per connection (resets if the client reconnects).
    //   - Up to 200 events per poll fetched (a single LLM run rarely
    //     exceeds 50 events — 200 is defensive against backlog).
    app.get('/v1/admin/runtime/work-items/:id/events/stream', {
        preHandler: readAuth,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const wiId = String((request.params as any).id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wiId)) {
            return reply.status(400).send({ error: 'invalid id (uuid expected)' });
        }

        const POLL_MS = 500;
        const MAX_DURATION_MS = 5 * 60 * 1000;
        const startedAt = Date.now();

        // Confirm the work_item exists + belongs to this org BEFORE we
        // hijack the reply (otherwise we'd send a chunked response only
        // to discover a 404 case).
        {
            const probe = await pgPool.connect();
            try {
                await probe.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                const exists = await probe.query(
                    `SELECT 1 FROM runtime_work_items WHERE id=$1::uuid AND org_id=$2`,
                    [wiId, orgId],
                );
                if (exists.rows.length === 0) {
                    return reply.status(404).send({ error: 'work_item not found' });
                }
            } finally {
                await probe.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                probe.release();
            }
        }

        // SSE handshake — same shape as chat.routes.ts hijacked stream
        // so ADR-022 cors-on-hijacked-sse coverage is automatic.
        const corsHeaders = buildCorsHeaders(request.headers.origin);
        reply.hijack();
        reply.raw.writeHead(200, {
            ...corsHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        let closed = false;
        request.raw.on('close', () => { closed = true; });

        let lastSeq = -1;
        const writeEvent = (eventName: string, data: any) => {
            if (closed) return false;
            try {
                reply.raw.write(`event: ${eventName}\n`);
                reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
                return true;
            } catch {
                closed = true;
                return false;
            }
        };

        // Initial keep-alive comment so EventSource clients see the
        // connection as open immediately, before the first event lands.
        try { reply.raw.write(`: connected ${Date.now()}\n\n`); } catch { closed = true; }

        const finalStatuses = new Set(['done', 'failed', 'blocked', 'cancelled']);

        try {
            while (!closed && (Date.now() - startedAt) < MAX_DURATION_MS) {
                const client = await pgPool.connect();
                let status = '';
                try {
                    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                    const evRes = await client.query(
                        `SELECT id, event_seq AS seq, event_type AS type,
                                tool_name, prompt_id, payload, created_at
                           FROM runtime_work_item_events
                          WHERE work_item_id = $1::uuid AND org_id = $2
                            AND event_seq > $3
                          ORDER BY event_seq ASC
                          LIMIT 200`,
                        [wiId, orgId, lastSeq],
                    );
                    for (const e of evRes.rows) {
                        if (closed) break;
                        const ev: RuntimeWorkItemEvent = {
                            id: e.id,
                            seq: Number(e.seq),
                            type: e.type,
                            tool_name: e.tool_name,
                            prompt_id: e.prompt_id,
                            payload: e.payload || {},
                            timestamp: e.created_at instanceof Date
                                ? e.created_at.toISOString()
                                : String(e.created_at),
                        };
                        if (!writeEvent(ev.type, ev)) break;
                        lastSeq = ev.seq;
                    }

                    const stRes = await client.query(
                        `SELECT status FROM runtime_work_items WHERE id=$1::uuid AND org_id=$2`,
                        [wiId, orgId],
                    );
                    status = stRes.rows[0]?.status || '';
                } finally {
                    await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                    client.release();
                }

                if (closed) break;
                if (finalStatuses.has(status)) {
                    writeEvent('stream_end', {
                        final_status: status,
                        closed_at_unix_ms: Date.now(),
                    });
                    break;
                }

                // Heartbeat comment every ~15s in case of an idle run —
                // proxies (nginx, ALB) drop SSE connections without
                // bytes for >60s.
                if (((Date.now() - startedAt) % 15000) < POLL_MS) {
                    try { reply.raw.write(`: heartbeat ${Date.now()}\n\n`); }
                    catch { closed = true; break; }
                }

                await new Promise(r => setTimeout(r, POLL_MS));
            }
        } finally {
            try { reply.raw.end(); } catch { /* already ended */ }
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // POST /v1/admin/runtime/work-items/:id/cancel
    // ──────────────────────────────────────────────────────────────────
    //
    // Same logic as the legacy /v1/admin/architect/work-items/:id/cancel
    // route — mark cancellation_requested_at, enqueue a `cancel-run`
    // BullMQ job. Worker picks it up and propagates SIGTERM to the
    // gRPC stream the runner holds.
    app.post('/v1/admin/runtime/work-items/:id/cancel', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            return reply.status(400).send({ error: 'invalid id (uuid expected)' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `UPDATE runtime_work_items
                    SET cancellation_requested_at = NOW()
                  WHERE id = $1::uuid AND org_id = $2
                    AND status IN ('pending', 'in_progress', 'awaiting_approval')
                  RETURNING id, status`,
                [id, orgId],
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'work_item not found or not cancellable' });
            }

            // Enqueue the worker job (same queue + name as the legacy route).
            const { runtimeQueue } = await import('../workers/runtime.worker');
            await runtimeQueue.add('cancel-run', { orgId, workItemId: id }, {
                attempts: 1,
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 50 },
            });

            return reply.send({
                cancelled: true,
                work_item_id: id,
                previous_status: result.rows[0].status,
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/admin/runtime/sessions
    // ──────────────────────────────────────────────────────────────────
    //
    // Lists CLI sessions tracked in Redis (claude-code-runner upserts
    // the per-org hash on every run). Sorted by last_used desc.
    app.get('/v1/admin/runtime/sessions', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        let raw: Record<string, string> = {};
        try {
            if (redisCache.status === 'ready') {
                raw = await redisCache.hgetall(`runtime:sessions:${orgId}`) || {};
            }
        } catch (err) {
            // Redis hiccup: return empty list; surface the issue in logs
            // but don't fail the request.
            request.log?.warn?.({ err }, 'sessions hgetall failed');
        }

        const items: RuntimeSession[] = [];
        for (const [sid, json] of Object.entries(raw)) {
            try {
                const meta = JSON.parse(json);
                items.push({
                    session_id: sid,
                    last_used_unix_ms: Number(meta.lastUsedUnixMs ?? 0),
                    message_count: Number(meta.messageCount ?? 0),
                    runtime_slug: String(meta.runtimeSlug ?? 'unknown'),
                    last_work_item_id: meta.workItemId ? String(meta.workItemId) : null,
                });
            } catch { /* malformed entry — skip */ }
        }
        items.sort((a, b) => b.last_used_unix_ms - a.last_used_unix_ms);

        const body: RuntimeSessionListResponse = { sessions: items };
        return reply.send(body);
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/admin/runtime/runners/health
    // ──────────────────────────────────────────────────────────────────
    //
    // Per-runtime availability + transport. Reuses the cached probe
    // from runtime-profiles.ts (30s TTL) so a tight admin-UI poll
    // doesn't hammer the filesystem.
    app.get('/v1/admin/runtime/runners/health', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const profiles = await listRuntimeProfiles(pgPool, orgId);
        const now = Date.now();

        const runners: RuntimeRunnerHealth[] = await Promise.all(
            profiles.map(async (p: RuntimeProfile) => {
                const available = await isRuntimeAvailableCached(p);
                const target = resolveRuntimeTarget(p);
                const transport: 'unix' | 'tcp' | 'unknown' = target.socketPath
                    ? 'unix'
                    : (target.host ? 'tcp' : 'unknown');
                return {
                    slug: p.slug,
                    display_name: p.display_name,
                    available,
                    last_check_unix_ms: now,
                    transport,
                    socket_path: target.socketPath ?? null,
                    grpc_host: target.host ?? null,
                    runtime_class: p.runtime_class,
                    claim_level: (p as any).config?.claim_level ?? null,
                };
            })
        );

        const body: RuntimeRunnerHealthResponse = { runners };
        return reply.send(body);
    });
}
