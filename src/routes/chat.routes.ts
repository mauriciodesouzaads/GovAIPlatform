/**
 * Chat Routes — FASE 6
 *
 * Powers the /playground chat surface. Adapts the JWT-authenticated admin
 * session into calls to the existing /v1/execute pipeline (which expects
 * a per-org API key), exposes the assistant catalog with delegation/skill
 * metadata, and paginates conversation history from the immutable audit
 * log (grouped by traceId as session proxy).
 *
 *   POST /v1/admin/chat/send                         — JWT → pipeline wrapper
 *   GET  /v1/admin/chat/sessions                     — recent chat sessions
 *   GET  /v1/admin/chat/sessions/:sessionId/messages — reconstruct messages
 *   GET  /v1/admin/assistants/available              — assistants + delegation + skill count
 *   GET  /v1/admin/llm/models                        — LiteLLM models (with fallback)
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import axios from 'axios';

interface SendBody {
    assistant_id: string;
    message: string;
    session_id?: string;
    model?: string;
    force_delegate?: boolean;
}

export async function chatRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;

    const readAuth  = requireRole(['admin', 'operator', 'dpo', 'auditor']);
    const writeAuth = requireRole(['admin', 'operator', 'dpo']);

    // ── POST /v1/admin/chat/send ──────────────────────────────────────────────
    // Wrapper: authenticates via JWT (sidebar), resolves the org's API key,
    // and forwards to the existing Bearer-authenticated /v1/execute pipeline.
    // Nothing else — the full governance pipeline (OPA, DLP, FinOps, RAG,
    // delegation check) runs exactly as it does for API key callers.
    fastify.post('/v1/admin/chat/send', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const body = (request.body ?? {}) as SendBody;
        if (!body.assistant_id || !body.message) {
            return reply.status(400).send({ error: 'assistant_id e message são obrigatórios.' });
        }

        const apiKey = process.env.GOVAI_DEMO_API_KEY || 'sk-govai-demo00000000000000000000';

        // ⚡ Force-delegate mode: prepend [OPENCLAUDE] so the execution.service
        //   delegation regex matches (seed guarantees this pattern exists).
        const message = body.force_delegate
            ? `[OPENCLAUDE] ${body.message}`
            : body.message;

        // Loopback: call ourselves on 127.0.0.1 — this exercises the real
        // middleware stack (API key auth, DLP, policy, FinOps, RAG, LiteLLM).
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await axios.post(
                `http://127.0.0.1:3000/v1/execute/${body.assistant_id}`,
                {
                    message,
                    ...(body.session_id ? { sessionId: body.session_id } : {}),
                    ...(body.model ? { model: body.model } : {}),
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'x-govai-chat-proxy': 'true',
                    },
                    timeout: 120_000,
                    validateStatus: () => true,
                }
            );

            // FASE 6b multi-agent: annotate the response with the assistant
            // that handled it so the UI can render distinct avatars/names
            // when the user switches assistants mid-conversation.
            if (result.data && typeof result.data === 'object') {
                if (!result.data._govai) result.data._govai = {};
                result.data._govai.assistantId = body.assistant_id;
                try {
                    const nameRes = await client.query(
                        `SELECT name FROM assistants WHERE id = $1 AND org_id = $2`,
                        [body.assistant_id, orgId]
                    );
                    result.data._govai.assistantName = nameRes.rows[0]?.name ?? 'Assistente';
                } catch {
                    result.data._govai.assistantName = 'Assistente';
                }
            }

            return reply.status(result.status).send(result.data);
        } catch (err: any) {
            fastify.log.error(err, 'Chat wrapper upstream error');
            return reply.status(502).send({
                error: 'Falha ao comunicar com o pipeline de execução.',
                detail: err?.message || String(err),
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/chat/send/stream ───────────────────────────────────────
    // FASE 6b — Server-Sent Events variant of /chat/send. The governance
    // pipeline (OPA, DLP, FinOps, RAG) still runs synchronously via the
    // loopback call, but the LLM completion is emitted to the client as a
    // series of progressive chunks for a streaming UX.
    //
    // Frames:
    //   data: {"chunk":"..."}           — progressive text, repeated
    //   data: {"done":true,"usage":...} — terminal; stream closed after
    //   data: {"delegated":true,...}    — delegation path (no chunks)
    //   data: {"error":true,"status":N,"data":{...}} — error path
    //
    // force_delegate=true short-circuits to the non-stream behavior
    // (JSON response, not SSE) because delegation has no streamable text.
    fastify.post('/v1/admin/chat/send/stream', { preHandler: writeAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const body = (request.body ?? {}) as SendBody;
        if (!body.assistant_id || !body.message) {
            return reply.status(400).send({ error: 'assistant_id e message são obrigatórios.' });
        }

        const apiKey = process.env.GOVAI_DEMO_API_KEY || 'sk-govai-demo00000000000000000000';

        // ── Short-circuit: force_delegate → plain JSON (no SSE) ──────────────
        // Delegation spawns a background run; there's nothing to stream.
        if (body.force_delegate) {
            const client = await pgPool.connect();
            try {
                await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
                const result = await axios.post(
                    `http://127.0.0.1:3000/v1/execute/${body.assistant_id}`,
                    {
                        message: `[OPENCLAUDE] ${body.message}`,
                        ...(body.session_id ? { sessionId: body.session_id } : {}),
                        ...(body.model ? { model: body.model } : {}),
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                            'x-govai-chat-proxy': 'true',
                        },
                        timeout: 120_000,
                        validateStatus: () => true,
                    }
                );
                if (result.data && typeof result.data === 'object') {
                    if (!result.data._govai) result.data._govai = {};
                    result.data._govai.assistantId = body.assistant_id;
                    const nameRes = await client.query(
                        `SELECT name FROM assistants WHERE id = $1 AND org_id = $2`,
                        [body.assistant_id, orgId]
                    );
                    result.data._govai.assistantName = nameRes.rows[0]?.name ?? 'Assistente';
                }
                return reply.status(result.status).send(result.data);
            } finally {
                await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                client.release();
            }
        }

        // ── Normal path: loopback + chunked emission ─────────────────────────
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Assume control of the response before writing headers — Fastify
            // will otherwise intercept and JSON-encode.
            reply.hijack();
            reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            });

            const sendFrame = (payload: Record<string, unknown>) => {
                reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
            };

            // Run the full governance pipeline via loopback. Streaming is
            // simulated client-side (chunks after completion) for v1 — the
            // UX already matches a real stream once the pipeline latency
            // is covered by the typing indicator.
            const result = await axios.post(
                `http://127.0.0.1:3000/v1/execute/${body.assistant_id}`,
                {
                    message: body.message,
                    ...(body.session_id ? { sessionId: body.session_id } : {}),
                    ...(body.model ? { model: body.model } : {}),
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                        'x-govai-chat-proxy': 'true',
                    },
                    timeout: 120_000,
                    validateStatus: () => true,
                }
            );

            // Resolve assistant name once — used for every terminal frame
            const nameRes = await client.query(
                `SELECT name FROM assistants WHERE id = $1 AND org_id = $2`,
                [body.assistant_id, orgId]
            );
            const assistantName = nameRes.rows[0]?.name ?? 'Assistente';

            // ── Error path ───────────────────────────────────────────────────
            if (result.status >= 400) {
                sendFrame({ error: true, status: result.status, data: result.data });
                reply.raw.end();
                return;
            }

            // ── Delegation path ──────────────────────────────────────────────
            if (result.data?._govai?.delegated === true) {
                if (!result.data._govai) result.data._govai = {};
                result.data._govai.assistantId = body.assistant_id;
                result.data._govai.assistantName = assistantName;
                sendFrame({ delegated: true, ...result.data });
                reply.raw.end();
                return;
            }

            // ── Normal streaming path ────────────────────────────────────────
            const fullContent: string =
                result.data?.choices?.[0]?.message?.content ?? '(sem resposta)';

            // Split preserving whitespace, emit 3-token chunks with micro-delay
            const tokens = fullContent.split(/(\s+)/).filter(t => t.length > 0);
            const CHUNK_SIZE = 3;
            for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
                const chunk = tokens.slice(i, i + CHUNK_SIZE).join('');
                if (chunk) sendFrame({ chunk });
                // 15ms between chunks = smooth type-in without blocking too long
                await new Promise(r => setTimeout(r, 15));
                // Client abort → stop emitting
                if (reply.raw.destroyed) break;
            }

            sendFrame({
                done: true,
                usage: result.data?.usage ?? {},
                traceId: result.data?._govai?.traceId ?? null,
                signature: result.data?._govai?.signature ?? null,
                assistantId: body.assistant_id,
                assistantName,
            });
            reply.raw.end();
        } catch (err: any) {
            fastify.log.error(err, 'Chat stream wrapper upstream error');
            try {
                reply.raw.write(`data: ${JSON.stringify({
                    error: true,
                    status: 502,
                    data: { error: err?.message ?? 'stream_upstream_error' },
                })}\n\n`);
                reply.raw.end();
            } catch { /* already closed */ }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/chat/sessions ───────────────────────────────────────────
    // Groups recent audit entries by (trace_id, assistant_id) and returns the
    // most recent 30 sessions. Uses audit_logs_partitioned — the canonical
    // source of truth — with RLS enforced via set_config.
    fastify.get('/v1/admin/chat/sessions', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const result = await client.query(
                `SELECT
                    COALESCE(trace_id::text, metadata->>'traceId') AS session_id,
                    assistant_id,
                    MAX(a.name)                       AS assistant_name,
                    MIN(al.created_at)                AS started_at,
                    MAX(al.created_at)                AS last_at,
                    COUNT(*) FILTER (WHERE al.action IN ('EXECUTION', 'EXECUTION_SUCCESS')) AS message_count,
                    BOOL_OR(al.metadata->>'delegated' = 'true') AS has_delegation
                 FROM audit_logs_partitioned al
                 LEFT JOIN assistants a ON a.id = al.assistant_id
                 WHERE al.org_id = $1
                   AND al.action IN ('EXECUTION', 'EXECUTION_SUCCESS', 'POLICY_VIOLATION')
                   AND COALESCE(trace_id::text, metadata->>'traceId') IS NOT NULL
                   AND al.created_at > NOW() - INTERVAL '30 days'
                 GROUP BY COALESCE(trace_id::text, metadata->>'traceId'), assistant_id
                 ORDER BY last_at DESC
                 LIMIT 30`,
                [orgId]
            );

            return reply.send(result.rows.map(r => ({
                session_id:     r.session_id,
                assistant_id:   r.assistant_id,
                assistant_name: r.assistant_name,
                started_at:     r.started_at,
                last_at:        r.last_at,
                message_count:  Number(r.message_count) || 0,
                has_delegation: Boolean(r.has_delegation),
            })));
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/chat/sessions/:sessionId/messages ───────────────────────
    // Reconstructs the conversation from audit_logs_partitioned. The metadata
    // column carries prompt/completion/delegated/workItemId fields written by
    // the execution pipeline, so we can fan out back into user + assistant pairs.
    fastify.get('/v1/admin/chat/sessions/:sessionId/messages', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { sessionId } = request.params as { sessionId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, action, metadata, created_at, trace_id, assistant_id
                 FROM audit_logs_partitioned
                 WHERE org_id = $1
                   AND (trace_id::text = $2 OR metadata->>'traceId' = $2)
                 ORDER BY created_at ASC
                 LIMIT 200`,
                [orgId, sessionId]
            );

            const messages: Array<Record<string, unknown>> = [];
            for (const row of result.rows) {
                const md = (row.metadata as Record<string, unknown>) ?? {};
                if (row.action === 'POLICY_VIOLATION') {
                    messages.push({
                        role: 'error',
                        kind: 'policy_violation',
                        content: md.reason ?? 'Política violada',
                        timestamp: row.created_at,
                    });
                    continue;
                }
                if (typeof md.prompt === 'string' && md.prompt.length > 0) {
                    messages.push({ role: 'user', content: md.prompt, timestamp: row.created_at });
                }
                if (md.delegated === true || md.delegated === 'true') {
                    messages.push({
                        role: 'delegation',
                        workItemId: md.workItemId,
                        matchedPattern: md.matchedPattern,
                        timestamp: row.created_at,
                    });
                    continue;
                }
                if (typeof md.completion === 'string' && md.completion.length > 0) {
                    messages.push({
                        role: 'assistant',
                        content: md.completion,
                        tokens: md.tokens ?? null,
                        timestamp: row.created_at,
                        traceId: row.trace_id ?? md.traceId,
                    });
                }
            }

            return reply.send({ session_id: sessionId, messages });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/assistants/available ────────────────────────────────────
    // List assistants available for the chat UI with delegation config and
    // the count of skills bound to each.
    fastify.get('/v1/admin/assistants/available', { preHandler: readAuth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT
                    a.id, a.name, a.description, a.status, a.lifecycle_state,
                    a.delegation_config, a.capability_tags, a.risk_level,
                    COALESCE(
                      (SELECT COUNT(*)
                         FROM assistant_skill_bindings asb
                        WHERE asb.assistant_id = a.id
                          AND asb.org_id = a.org_id
                          AND asb.is_active = true),
                      0
                    ) AS skill_count
                 FROM assistants a
                 WHERE a.org_id = $1
                   AND a.lifecycle_state IN ('official', 'draft')
                 ORDER BY a.lifecycle_state, a.name ASC`,
                [orgId]
            );
            return reply.send(result.rows.map(r => ({
                id:                  r.id,
                name:                r.name,
                description:         r.description,
                status:              r.status,
                lifecycle_state:     r.lifecycle_state,
                delegation_config:   r.delegation_config,
                delegation_enabled:  r.delegation_config?.enabled === true,
                capability_tags:     r.capability_tags ?? [],
                risk_level:          r.risk_level,
                skill_count:         Number(r.skill_count) || 0,
            })));
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/llm/models ──────────────────────────────────────────────
    // Tries LiteLLM's /model/info for the live inventory; falls back to a
    // single synthetic entry so the UI always has a sensible option.
    fastify.get('/v1/admin/llm/models', { preHandler: readAuth }, async (_request: any, reply) => {
        const litellmUrl = process.env.LITELLM_URL || 'http://litellm:4000';
        const litellmKey = process.env.LITELLM_KEY || '';

        const fallback = [{
            id: 'govai-llm',
            name: 'GovAI LLM (Auto-failover)',
            provider: 'litellm',
            default: true,
        }];

        try {
            const r = await axios.get(`${litellmUrl}/model/info`, {
                headers: litellmKey ? { Authorization: `Bearer ${litellmKey}` } : {},
                timeout: 5_000,
                validateStatus: () => true,
            });
            if (r.status !== 200 || !Array.isArray(r.data?.data)) {
                return reply.send(fallback);
            }
            const seen = new Set<string>();
            const models: Array<Record<string, unknown>> = [];
            for (const item of r.data.data as Array<Record<string, any>>) {
                const modelName = item.model_name || item.model_info?.id || item.id;
                if (!modelName || seen.has(modelName)) continue;
                seen.add(modelName);
                const provider = item.litellm_params?.custom_llm_provider
                    || item.model_info?.provider
                    || (typeof item.litellm_params?.model === 'string' ? item.litellm_params.model.split('/')[0] : 'litellm');
                models.push({
                    id:       modelName,
                    name:     modelName,
                    provider,
                    default:  modelName === 'govai-llm',
                });
            }
            if (models.length === 0) return reply.send(fallback);
            // Make sure govai-llm is first
            models.sort((a, b) => (a.default ? -1 : b.default ? 1 : 0));
            return reply.send(models);
        } catch {
            return reply.send(fallback);
        }
    });
}
