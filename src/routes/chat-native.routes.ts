/**
 * Chat Native UI Routes — FASE 14.0/6c.A
 * ---------------------------------------------------------------------------
 * Mounted under /v1/chat — distinct from /v1/admin/chat/* (legacy Redis-
 * sessions) which stays alive for backwards-compat with admin tools.
 *
 * What this layer owns:
 *   * conversations CRUD with persistent storage in chat_conversations
 *   * messages listing + send with SSE streaming via LiteLLM
 *   * attachments upload + download
 *   * llm_providers catalog (read-only, seeded by migration 097)
 *
 * Multi-tenancy: every query sets app.current_org_id and the tables
 * have RLS forcing org_id matches. The same pattern as 6a₁/6a₂ admin
 * routes — see runtime-admin.routes.ts for prior art.
 *
 * Streaming protocol: SSE over a hijacked Fastify reply, identical to
 * runtime-admin's events stream. Each chunk wraps a JSON envelope:
 *
 *   { type: 'delta', content: '...' }
 *   { type: 'done', message_id, tokens: { in, out } }
 *   { type: 'error', error: '...' }
 *
 * Why a JSON envelope and not raw OpenAI SSE: clients in
 * admin-ui consume one thin contract. We don't expose LiteLLM's
 * choice-array shape directly because if we ever swap the upstream,
 * the frontend doesn't move.
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';
import { buildCorsHeaders } from '../lib/cors-config';
import { scanDocumentForPII } from '../lib/dlp-document-scanner';
import { searchAcrossKnowledgeBases } from '../lib/qdrant';
import { getEmbeddingProvider } from '../lib/embeddings';

const ATTACHMENTS_ROOT =
    process.env.GOVAI_CHAT_ATTACHMENTS_BASE || '/var/govai/chat-attachments';

const LITELLM_URL = process.env.LITELLM_URL || 'http://litellm:4000';
const LITELLM_KEY = process.env.LITELLM_KEY || process.env.LITELLM_MASTER_KEY || '';

// Default cap on history sent to the LLM. Keeps us under most context
// windows without pretending to be smart about token counting (LiteLLM
// will surface 400s if the conversation actually exceeds the model's
// limit). 50 turns covers ~95% of conversations in practice.
const HISTORY_LIMIT = 50;

// ── Validation schemas ──────────────────────────────────────────────────────

// FASE 14.0/6c.A.1 — UUID loose regex (não exige RFC 4122 v4 strict)
// porque fixture IDs como 00000000-0000-0000-0fff-000000000007 são
// uuid-shaped mas não cumprem a versão. Postgres aceita; zod strict
// rejeita sem essa relaxação. Mesmo padrão usado em runtime-admin.routes.
const UUID_LOOSE = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'malformed uuid (expected 36-char hyphenated hex)',
);

const conversationCreateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    mode: z.enum(['chat', 'code', 'cowork']).optional(),
    default_model: z.string().min(1).max(100).optional(),
    knowledge_base_ids: z.array(UUID_LOOSE).max(20).optional(),
    // FASE 14.0/6c.A.1 — vínculo opcional com agente vertical
    assistant_id: UUID_LOOSE.optional(),
});

const conversationUpdateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    default_model: z.string().min(1).max(100).optional(),
    knowledge_base_ids: z.array(UUID_LOOSE).max(20).optional(),
    assistant_id: UUID_LOOSE.nullable().optional(),
});

const sendMessageSchema = z.object({
    content: z.string().min(1).max(50_000),
    // model é obrigatório em mode='chat' (LiteLLM passthrough); em
    // mode='code' o model fica determinado pelo agente vinculado
    // (default Claude Code Auditado se conversation é livre).
    model: z.string().min(1).max(100).optional(),
    attachments_ids: z.array(UUID_LOOSE).max(10).optional(),
    // FASE 14.0/6c.B — discriminador do turn:
    //   chat (default) → LiteLLM passthrough multi-LLM (6c.A)
    //   code           → dispatchWorkItem (Claude Code SDK nativo, 5b.2)
    mode: z.enum(['chat', 'code']).optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function withOrg<T>(
    pool: Pool,
    orgId: string,
    fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        return await fn(client);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

interface RetrievalChunk {
    score: number;
    content: string;
    documentId?: string;
}

/**
 * Retrieve RAG chunks scoped to the conversation's linked KBs.
 * Failure is non-fatal — chat continues without grounding context if
 * Qdrant is down or embeddings fail.
 *
 * 6c.A.1 — escreve em retrieval_log quando há hits, para que chat
 * conversations apareçam na mesma trilha de auditoria que
 * dispatchWorkItem. Sem isso, retrievals via /chat ficam invisíveis
 * para o painel de governança.
 */
async function retrieveChunks(
    pool: Pool,
    orgId: string,
    query: string,
    kbIds: string[],
    convId: string,
): Promise<RetrievalChunk[]> {
    if (!kbIds || kbIds.length === 0) return [];
    const startTs = Date.now();
    try {
        const provider = getEmbeddingProvider();
        const [vec] = await provider.embed([query]);
        const top = parseInt(process.env.RAG_RETRIEVAL_TOP_K || '5', 10);
        const minScore = parseFloat(process.env.RAG_RETRIEVAL_MIN_SCORE || '0.6');
        const hits = await searchAcrossKnowledgeBases(orgId, kbIds, vec, {
            topK: top,
            minScore,
        });

        // Audit log — written to retrieval_log so chat retrievals show
        // up in the governance panel alongside Modo Agente dispatch
        // retrievals. Best-effort: if the INSERT fails (RLS, transient
        // DB error), the chat continues without breaking. retrieval_log
        // doesn't have a chat_conversation_id column (was designed for
        // work_item_id only); we stash conv id under metadata via
        // query_preview prefix to preserve the link.
        if (hits.length > 0) {
            try {
                // RLS força app.current_org_id ser igual a org_id no
                // INSERT. Usar withOrg para setar antes da query.
                await withOrg(pool, orgId, async client => {
                    await client.query(
                        `INSERT INTO retrieval_log
                            (org_id, knowledge_base_id, query_preview,
                             chunks_retrieved, top_score, latency_ms)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            orgId,
                            kbIds[0],
                            `[chat:${convId.substring(0, 8)}] ${query.substring(0, 180)}`,
                            hits.length,
                            hits[0].score,
                            Date.now() - startTs,
                        ],
                    );
                });
            } catch (logErr) {
                console.warn('[chat] retrieval_log write failed (non-fatal):', (logErr as Error).message);
            }
        }

        return hits.map(h => ({
            score: h.score,
            content: (h.payload as any)?.content ?? '',
            documentId: (h.payload as any)?.document_id,
        }));
    } catch (err) {
        console.warn('[chat] RAG retrieval failed (non-fatal):', (err as Error).message);
        return [];
    }
}

/**
 * Calls LiteLLM /v1/chat/completions with `stream: true` and returns the
 * raw response. The caller iterates the SSE body and forwards JSON
 * envelopes to its own client.
 */
async function streamFromLitellm(
    model: string,
    messages: Array<{ role: string; content: string }>,
): Promise<Response> {
    const body = {
        model,
        messages,
        stream: true,
        // Asking LiteLLM to include token usage in the final SSE chunk
        // means we don't need a follow-up request to count tokens.
        stream_options: { include_usage: true },
    };
    const res = await fetch(`${LITELLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${LITELLM_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>');
        throw new Error(`LiteLLM ${res.status}: ${text.substring(0, 500)}`);
    }
    if (!res.body) {
        throw new Error('LiteLLM returned no body');
    }
    return res;
}

// ── Code mode turn handler (FASE 14.0/6c.B) ─────────────────────────────────
//
// Mode Code reuses the 5b.2 pipeline:
//   1. INSERT runtime_work_items with execution_context.source='chat'
//      so anyone reading the row knows it came from /chat (operations
//      panel can offer "Open in chat" link, audit trail is unified).
//   2. INSERT chat_messages assistant placeholder with mode='code',
//      work_item_id pointing at the new WI. Persists immediately so
//      a refresh of /chat/<id> mid-stream still loads the correct
//      shape (tool timeline placeholder + work_item_id).
//   3. Enqueue dispatch-openclaude BullMQ job — the worker calls
//      dispatchWorkItem which runs Claude Code SDK + writes events
//      to runtime_work_item_events.
//   4. Hijack reply for SSE; poll runtime_work_item_events @500ms
//      forwarding each event as a JSON envelope. Same shape as the
//      existing /v1/admin/runtime/work-items/:id/events/stream endpoint
//      (5a) so the UI client can reuse parsing logic.
//   5. On RUN_COMPLETED/RUN_FAILED, persist final aggregated text in
//      chat_messages.content + tokens + tool_count + emit `done` and
//      end the stream.
//
// Why polling DB instead of subscribing to the in-process emitter:
// the dispatch worker can run in a different process (multi-instance
// k8s) — runtime_work_item_events is the system-of-record. The 500ms
// poll matches the existing /events/stream endpoint and is invisible
// to humans for chat latency.

interface CodeStreamCtx {
    workItemId: string;
    assistantMsgId: string;
    convId: string;
    orgId: string;
}

async function handleCodeTurn(
    pgPool: Pool,
    orgId: string,
    convId: string,
    content: string,
    attachmentsIds: string[],
    request: any,
    reply: any,
    dlp: ReturnType<typeof scanDocumentForPII>,
): Promise<void> {
    // Default fixture for free conversations: Claude Code Auditado
    // (id 00000000-0000-0000-0fff-000000000002, runtime profile
    // claude_code_official, audit hooks enabled). When conversation
    // has assistant_id, that assistant runs.
    const FALLBACK_AGENT_ID = '00000000-0000-0000-0fff-000000000002';

    // 1+2. Pre-stream DB writes (single connection, single transaction
    // boundary for consistency between user msg, WI, assistant msg).
    let ctx: CodeStreamCtx;
    let runtimeProfileSlug: string;
    try {
        ctx = await withOrg(pgPool, orgId, async client => {
            // Resolve the assistant: conv.assistant_id if linked,
            // else fallback. Validate it belongs to the org.
            const convRow = await client.query(
                `SELECT cc.assistant_id, cc.default_model
                   FROM chat_conversations cc
                  WHERE cc.id = $1::uuid AND cc.org_id = $2`,
                [convId, orgId],
            );
            if (convRow.rows.length === 0) throw new Error('NOT_FOUND');

            const assistantId = convRow.rows[0].assistant_id ?? FALLBACK_AGENT_ID;

            const ar = await client.query(
                `SELECT id, runtime_profile_slug
                   FROM assistants
                  WHERE id = $1::uuid AND org_id = $2`,
                [assistantId, orgId],
            );
            if (ar.rows.length === 0) {
                throw new Error('AGENT_NOT_FOUND');
            }
            const slug = ar.rows[0].runtime_profile_slug ?? 'claude_code_official';
            runtimeProfileSlug = slug;
            // execution_hint follows the slug→hint convention
            // (see runtime-admin POST /work-items + execution.service.ts).
            const executionHint = slug === 'claude_code_official'
                ? 'claude_code'
                : 'openclaude';

            // INSERT user message (role='user', mode='code'). DLP scan
            // result attached if any PII was masked (action='allow' or
            // 'redact' — block was rejected before reaching here).
            const userMsg = await client.query(
                `INSERT INTO chat_messages
                    (conversation_id, org_id, role, content, mode,
                     attachments_ids, dlp_scan)
                 VALUES ($1, $2, 'user', $3, 'code', $4, $5)
                 RETURNING id`,
                [
                    convId, orgId, content, attachmentsIds,
                    dlp.has_pii ? JSON.stringify(dlp) : null,
                ],
            );
            const userMsgId = userMsg.rows[0].id;

            // INSERT runtime_work_item — the unit of work the
            // dispatch worker will process.
            const wiId = randomUUID();
            const titleSnippet = content.length > 80
                ? content.substring(0, 77) + '…'
                : content;
            await client.query(
                `INSERT INTO runtime_work_items (
                    id, org_id, node_id, item_type, title, description,
                    execution_hint, status, execution_context,
                    runtime_profile_slug, assistant_id, execution_mode
                 ) VALUES (
                    $1, $2, $3, 'compliance_check', $4, $5,
                    $6, 'pending', $7::jsonb, $8, $9, 'agent'
                 )`,
                [
                    wiId, orgId,
                    `chat-${wiId.substring(0, 8)}`,
                    `[chat] ${titleSnippet}`,
                    content,
                    executionHint,
                    JSON.stringify({
                        source: 'chat',
                        conversation_id: convId,
                        chat_user_message_id: userMsgId,
                        instructions: content,
                        assistant_id: assistantId,
                    }),
                    slug,
                    assistantId,
                ],
            );

            // INSERT assistant placeholder linked to the WI. content=''
            // until RUN_COMPLETED; UI shows streaming timeline based on
            // work_item_events. mode='code' so the renderer picks the
            // tool-timeline component instead of the markdown bubble.
            const asstMsg = await client.query(
                `INSERT INTO chat_messages
                    (conversation_id, org_id, role, content, mode, model,
                     work_item_id)
                 VALUES ($1, $2, 'assistant', '', 'code', $3, $4)
                 RETURNING id`,
                [convId, orgId, slug, wiId],
            );
            const asstMsgId = asstMsg.rows[0].id;

            return { workItemId: wiId, assistantMsgId: asstMsgId, convId, orgId };
        });
    } catch (err) {
        const m = (err as Error).message;
        if (m === 'NOT_FOUND') return reply.status(404).send({ error: 'conversation not found' });
        if (m === 'AGENT_NOT_FOUND') return reply.status(404).send({ error: 'assistant not found' });
        throw err;
    }

    // 3. Enqueue dispatch BullMQ job. The worker handles the actual
    // gRPC call to claude-code-runner and writes events to the
    // runtime_work_item_events table.
    const { runtimeQueue } = await import('../workers/runtime.worker');
    await runtimeQueue.add('dispatch-openclaude',
        { orgId, workItemId: ctx.workItemId },
        {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { count: 100 },
            removeOnFail:     { count: 100 },
        },
    );

    // 4. Hijack response for SSE streaming.
    const corsHeaders = buildCorsHeaders(request.headers.origin);
    reply.hijack();
    reply.raw.writeHead(200, {
        ...corsHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const writeEnv = (env: Record<string, unknown>): boolean => {
        try {
            reply.raw.write(`data: ${JSON.stringify(env)}\n\n`);
            return true;
        } catch {
            return false;
        }
    };

    let aborted = false;
    request.raw.on('close', () => { aborted = true; });

    // Initial keep-alive comment + start envelope so the client knows
    // the work_item_id and message_id immediately (used to deep-link
    // to /execucoes/<work_item_id> for full panel view).
    try { reply.raw.write(`: connected ${Date.now()}\n\n`); } catch { aborted = true; }
    writeEnv({
        type: 'mode_code_started',
        work_item_id: ctx.workItemId,
        message_id: ctx.assistantMsgId,
        runtime_profile_slug: runtimeProfileSlug!,
    });

    // 5. Poll runtime_work_item_events at 500ms, forwarding each event.
    const POLL_MS = 500;
    const MAX_DURATION_MS = 30 * 60 * 1000; // 30min — code runs longer than chat
    const startedAt = Date.now();
    let lastSeq = -1;
    let finalStatus = '';
    const finalStatuses = new Set(['done', 'failed', 'blocked', 'cancelled']);

    try {
        while (!aborted && (Date.now() - startedAt) < MAX_DURATION_MS) {
            const client = await pgPool.connect();
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
                    [ctx.workItemId, orgId, lastSeq],
                );
                for (const e of evRes.rows) {
                    if (aborted) break;
                    const ev = {
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
                    if (!writeEnv(ev)) { aborted = true; break; }
                    lastSeq = ev.seq;
                }

                const stRes = await client.query(
                    `SELECT status FROM runtime_work_items
                      WHERE id=$1::uuid AND org_id=$2`,
                    [ctx.workItemId, orgId],
                );
                finalStatus = stRes.rows[0]?.status || '';
            } finally {
                await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                client.release();
            }

            if (aborted) break;
            if (finalStatuses.has(finalStatus)) break;

            await new Promise(r => setTimeout(r, POLL_MS));
        }
    } catch (err) {
        writeEnv({ type: 'error', error: (err as Error).message });
    }

    // 5.5 Persist consolidated text on the assistant chat_message so
    // history reload (refresh /chat/<id>) shows the final answer
    // alongside the live event timeline (events are still queryable
    // via the work_item link).
    if (!aborted) {
        try {
            await persistAssistantFromWorkItem(pgPool, orgId, ctx);
        } catch (err) {
            console.warn('[chat code] persist final failed:', (err as Error).message);
        }
    }

    // Emit terminal envelope.
    if (!aborted) {
        if (finalStatus === 'done') {
            writeEnv({ type: 'done', work_item_id: ctx.workItemId });
        } else {
            writeEnv({
                type: 'error',
                error: `run ended with status=${finalStatus || 'unknown'}`,
            });
        }
    }
    try { reply.raw.end(); } catch { /* already ended */ }
}

/**
 * After RUN_COMPLETED, distill the run's final text into
 * chat_messages.content so the conversation reloads cleanly.
 *
 * Strategy: read aggregated tool count + tokens + the last
 * MESSAGE_DELTA-equivalent text from execution_context (the dispatch
 * pipeline writes both `dispatched_instruction` for audit and the
 * final assistant text into execution_context.output.fullText —
 * see runtime-delegation.ts:1497).
 */
async function persistAssistantFromWorkItem(
    pool: Pool,
    orgId: string,
    ctx: CodeStreamCtx,
): Promise<void> {
    await withOrg(pool, orgId, async client => {
        const wi = await client.query(
            `SELECT execution_context, dispatch_error
               FROM runtime_work_items
              WHERE id = $1::uuid AND org_id = $2`,
            [ctx.workItemId, orgId],
        );
        const ec = (wi.rows[0]?.execution_context ?? {}) as Record<string, any>;
        const finalText: string =
            ec.output?.fullText
            ?? ec.final_text
            ?? wi.rows[0]?.dispatch_error
            ?? '';

        // Aggregate tool count from runtime_work_item_events instead
        // of trusting execution_context shape.
        const counts = await client.query(
            `SELECT
                SUM(CASE WHEN event_type='TOOL_START' THEN 1 ELSE 0 END) AS tool_count
               FROM runtime_work_item_events
              WHERE work_item_id = $1::uuid AND org_id = $2`,
            [ctx.workItemId, orgId],
        );

        await client.query(
            `UPDATE chat_messages
                SET content = $1,
                    tokens_in = $2,
                    tokens_out = $3,
                    finish_reason = 'stop',
                    metadata = COALESCE(metadata, '{}'::jsonb) ||
                               jsonb_build_object('tool_count', $4::int)
              WHERE id = $5::uuid AND org_id = $6`,
            [
                finalText,
                ec.tokens?.prompt ?? null,
                ec.tokens?.completion ?? null,
                Number(counts.rows[0]?.tool_count ?? 0),
                ctx.assistantMsgId,
                orgId,
            ],
        );

        // Bump conversation last_message_at + auto-title.
        const autoTitle = ec.input?.instruction
            ? String(ec.input.instruction).substring(0, 57) + '…'
            : null;
        if (autoTitle) {
            await client.query(
                `UPDATE chat_conversations
                    SET last_message_at = NOW(),
                        title = CASE WHEN title = 'Nova conversa' THEN $2 ELSE title END
                  WHERE id = $1::uuid AND org_id = $3`,
                [ctx.convId, autoTitle, orgId],
            );
        } else {
            await client.query(
                `UPDATE chat_conversations
                    SET last_message_at = NOW()
                  WHERE id = $1::uuid AND org_id = $2`,
                [ctx.convId, orgId],
            );
        }
    });
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function chatNativeRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any },
) {
    const { pgPool, requireRole } = opts;
    // Anyone authenticated in the tenant can chat. We don't gate on
    // role here — the existing /v1/admin/chat/* is admin-only because
    // it ships with chat-keepalive and tooling, but this layer is the
    // user-facing product surface.
    const auth = requireRole(['admin', 'operator', 'dpo', 'auditor', 'consultant']);

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/chat/llm-providers
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/chat/llm-providers', { preHandler: auth }, async (_request: any, reply) => {
        // llm_providers has no RLS — global catalog. Single SELECT.
        const r = await pgPool.query(
            `SELECT provider, model_id, display_name, description,
                    context_window, max_output, capabilities,
                    is_default, icon_emoji, sort_order
               FROM llm_providers
              WHERE is_enabled = TRUE
              ORDER BY sort_order ASC, display_name ASC`,
        );
        return reply.send({
            providers: r.rows.map(row => ({
                provider: row.provider,
                model_id: row.model_id,
                display_name: row.display_name,
                description: row.description,
                context_window: row.context_window,
                max_output: row.max_output,
                capabilities: row.capabilities ?? [],
                is_default: row.is_default,
                icon_emoji: row.icon_emoji,
                sort_order: row.sort_order,
            })),
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/chat/conversations
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/chat/conversations', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const q = request.query as Record<string, string | undefined>;
        const archived = q.archived === 'true';
        const search = q.search ? q.search.trim() : '';
        const limit = Math.min(parseInt(q.limit || '50', 10), 200);

        return await withOrg(pgPool, orgId, async client => {
            const where: string[] = ['org_id = $1'];
            const params: any[] = [orgId];

            where.push(`archived = $${params.length + 1}`);
            params.push(archived);

            if (search) {
                params.push(`%${search}%`);
                where.push(`title ILIKE $${params.length}`);
            }

            params.push(limit);
            // 6c.A.1 LEFT JOIN assistants para enriquecer a sidebar com
            // avatar emoji + nome do agente quando conversation tem
            // assistant_id. Valores ficam null para chat livre.
            const r = await client.query(
                `SELECT cc.id, cc.title, cc.mode, cc.default_model,
                        cc.knowledge_base_ids, cc.assistant_id,
                        cc.pinned, cc.archived, cc.created_at, cc.updated_at,
                        cc.last_message_at,
                        a.name AS assistant_name,
                        a.avatar_emoji AS assistant_avatar,
                        a.category AS assistant_category
                   FROM chat_conversations cc
              LEFT JOIN assistants a ON cc.assistant_id = a.id
                  WHERE ${where.map(w => w.replace(/\borg_id\b/g, 'cc.org_id')
                                         .replace(/\barchived\b/g, 'cc.archived')
                                         .replace(/\btitle\b/g, 'cc.title')).join(' AND ')}
                  ORDER BY cc.pinned DESC, cc.last_message_at DESC NULLS LAST, cc.created_at DESC
                  LIMIT $${params.length}`,
                params,
            );
            return reply.send({ conversations: r.rows });
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // POST /v1/chat/conversations
    // ──────────────────────────────────────────────────────────────────
    //
    // FASE 14.0/6c.A.1 — quando body inclui assistant_id, fazemos resolver:
    //   * default_model herda de assistants.default_model (se body não
    //     sobrescrever explicitamente)
    //   * title inicial = nome do agente (operador renomeia depois)
    // Mantém os defaults globais (sonnet-4-6, "Nova conversa") para
    // conversation livre. Validamos que o agente pertence à org.
    app.post('/v1/chat/conversations', { preHandler: auth }, async (request: any, reply) => {
        const { orgId, userId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const parse = conversationCreateSchema.safeParse(request.body ?? {});
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const body = parse.data;

        return await withOrg(pgPool, orgId, async client => {
            // Resolução de defaults a partir do agente vinculado.
            let resolvedTitle = body.title ?? 'Nova conversa';
            let resolvedModel = body.default_model ?? 'claude-sonnet-4-6';
            let resolvedAssistantId: string | null = null;

            if (body.assistant_id) {
                const a = await client.query(
                    `SELECT id, name, default_model FROM assistants
                      WHERE id = $1::uuid AND org_id = $2`,
                    [body.assistant_id, orgId],
                );
                if (a.rows.length === 0) {
                    return reply.status(404).send({ error: 'assistant not found' });
                }
                resolvedAssistantId = a.rows[0].id;
                if (!body.title) resolvedTitle = a.rows[0].name;
                if (!body.default_model && a.rows[0].default_model) {
                    resolvedModel = a.rows[0].default_model;
                }
            }

            const r = await client.query(
                `INSERT INTO chat_conversations
                    (org_id, user_id, title, mode, default_model,
                     knowledge_base_ids, assistant_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id, title, mode, default_model, knowledge_base_ids,
                           assistant_id, pinned, archived, created_at,
                           updated_at, last_message_at`,
                [
                    orgId,
                    userId ?? null,
                    resolvedTitle,
                    body.mode ?? 'chat',
                    resolvedModel,
                    body.knowledge_base_ids ?? [],
                    resolvedAssistantId,
                ],
            );
            return reply.status(201).send(r.rows[0]);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/chat/conversations/:id
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/chat/conversations/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        return await withOrg(pgPool, orgId, async client => {
            // 6c.A.1 — detail enriquecido com agente vinculado +
            // suggested_prompts para o empty state da UI renderizar
            // chips clicáveis quando há agente.
            const r = await client.query(
                `SELECT cc.id, cc.title, cc.mode, cc.default_model,
                        cc.knowledge_base_ids, cc.assistant_id,
                        cc.pinned, cc.archived, cc.created_at, cc.updated_at,
                        cc.last_message_at, cc.metadata,
                        a.name AS assistant_name,
                        a.avatar_emoji AS assistant_avatar,
                        a.category AS assistant_category,
                        a.description AS assistant_description,
                        a.suggested_prompts AS assistant_suggested_prompts
                   FROM chat_conversations cc
              LEFT JOIN assistants a ON cc.assistant_id = a.id
                  WHERE cc.id = $1::uuid AND cc.org_id = $2`,
                [id, orgId],
            );
            if (r.rows.length === 0) {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            return reply.send(r.rows[0]);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // PATCH /v1/chat/conversations/:id
    // ──────────────────────────────────────────────────────────────────
    app.patch('/v1/chat/conversations/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        const parse = conversationUpdateSchema.safeParse(request.body ?? {});
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const body = parse.data;
        const sets: string[] = [];
        const params: any[] = [];
        for (const [k, v] of Object.entries(body)) {
            if (v === undefined) continue;
            params.push(v);
            sets.push(`${k} = $${params.length}`);
        }
        if (sets.length === 0) {
            return reply.status(400).send({ error: 'no fields to update' });
        }
        return await withOrg(pgPool, orgId, async client => {
            params.push(id, orgId);
            const r = await client.query(
                `UPDATE chat_conversations
                    SET ${sets.join(', ')}
                  WHERE id = $${params.length - 1}::uuid AND org_id = $${params.length}
                  RETURNING id, title, mode, default_model, knowledge_base_ids,
                            pinned, archived, created_at, updated_at, last_message_at`,
                params,
            );
            if (r.rows.length === 0) {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            return reply.send(r.rows[0]);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // DELETE /v1/chat/conversations/:id
    // ──────────────────────────────────────────────────────────────────
    app.delete('/v1/chat/conversations/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        return await withOrg(pgPool, orgId, async client => {
            const r = await client.query(
                `DELETE FROM chat_conversations WHERE id = $1::uuid AND org_id = $2 RETURNING id`,
                [id, orgId],
            );
            if (r.rows.length === 0) {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            return reply.status(204).send();
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/chat/conversations/:id/messages
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/chat/conversations/:id/messages', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');
        const q = request.query as Record<string, string | undefined>;
        const limit = Math.min(parseInt(q.limit || '100', 10), 500);

        return await withOrg(pgPool, orgId, async client => {
            const conv = await client.query(
                `SELECT 1 FROM chat_conversations WHERE id = $1::uuid AND org_id = $2`,
                [id, orgId],
            );
            if (conv.rows.length === 0) {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            const r = await client.query(
                `SELECT id, role, content, model, tokens_in, tokens_out, latency_ms,
                        finish_reason, tool_calls, attachments_ids, created_at,
                        mode, work_item_id, metadata
                   FROM chat_messages
                  WHERE conversation_id = $1::uuid AND org_id = $2
                  ORDER BY created_at ASC
                  LIMIT $3`,
                [id, orgId, limit],
            );
            return reply.send({ messages: r.rows });
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // POST /v1/chat/conversations/:id/messages          (SSE stream)
    // ──────────────────────────────────────────────────────────────────
    //
    // The flow:
    //   1. validate body, run DLP scan on user content (block on cpf/
    //      cnpj/credit_card hits — same policy as document upload)
    //   2. INSERT user message
    //   3. fetch conversation + linked KBs + recent history
    //   4. retrieve RAG chunks if KBs configured
    //   5. compose messages array (system_with_rag + history + user)
    //   6. POST to LiteLLM streaming, forward deltas as JSON envelopes
    //   7. on completion: INSERT assistant message + bump conversation
    //      last_message_at + auto-set title if it was 'Nova conversa'
    //
    // Errors fall into two buckets: pre-stream (return JSON 4xx/5xx
    // before hijacking) and during-stream (write `error` envelope and
    // close cleanly). Never leave a half-open SSE.
    app.post('/v1/chat/conversations/:id/messages', {
        preHandler: auth,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const convId = String((request.params as any).id || '');
        const parse = sendMessageSchema.safeParse(request.body ?? {});
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const { content, model, attachments_ids = [] } = parse.data;
        const turnMode = parse.data.mode ?? 'chat';

        // 1. DLP scan — reuse the document scanner so chat input applies
        // the same CPF/CNPJ/credit_card block policy as RAG upload.
        // Same policy applies whether the turn is chat or code.
        const dlp = scanDocumentForPII(content);
        if (dlp.action === 'block') {
            return reply.status(422).send({
                error: 'message blocked by DLP',
                hits: dlp.hits,
            });
        }

        // 6c.B — branch para Modo Code. Dispara dispatchWorkItem (5b.2
        // pipeline) em vez de LiteLLM passthrough. Stream SSE diferente
        // — em vez de delta tokens, emite tool_use_start, tool_use_output,
        // thinking_delta, etc. forwarded from runtime_work_item_events.
        if (turnMode === 'code') {
            return await handleCodeTurn(
                pgPool, orgId, convId, content, attachments_ids,
                request, reply, dlp,
            );
        }

        // 2-4. Pre-stream DB work, all under one connection so RLS is
        // set once and the conversation lookup + history fetch + user
        // INSERT + agent resolution are consistent.
        //
        // 6c.A.1 — quando conversation tem assistant_id, resolvemos:
        //   * system_prompt do agente (assistants.system_prompt)
        //   * KBs do agente (assistant_knowledge_bases) usadas como
        //     fallback para o RAG quando a conversation não tem KBs
        //     próprias setadas
        //   * skills do agente (assistant_skill_bindings + catalog_skills)
        // Tudo num único client connection para minimizar latência
        // antes do streaming abrir.
        interface ConvCtx {
            default_model: string;
            knowledge_base_ids: string[];
            assistant_id: string | null;
            assistant_system_prompt: string | null;
        }
        let conv: ConvCtx;
        let history: Array<{ role: string; content: string }>;
        let userMsgId: string;
        let agentKbIds: string[] = [];
        let agentSkillBlocks: string[] = [];

        try {
            await withOrg(pgPool, orgId, async client => {
                const c = await client.query(
                    `SELECT cc.default_model, cc.knowledge_base_ids, cc.assistant_id,
                            a.system_prompt AS assistant_system_prompt
                       FROM chat_conversations cc
                  LEFT JOIN assistants a ON cc.assistant_id = a.id
                      WHERE cc.id = $1::uuid AND cc.org_id = $2`,
                    [convId, orgId],
                );
                if (c.rows.length === 0) {
                    throw new Error('NOT_FOUND');
                }
                conv = c.rows[0];

                const h = await client.query(
                    `SELECT role, content
                       FROM chat_messages
                      WHERE conversation_id = $1::uuid AND org_id = $2
                      ORDER BY created_at DESC
                      LIMIT $3`,
                    [convId, orgId, HISTORY_LIMIT],
                );
                history = h.rows.reverse();

                const u = await client.query(
                    `INSERT INTO chat_messages
                        (conversation_id, org_id, role, content, attachments_ids, dlp_scan)
                     VALUES ($1, $2, 'user', $3, $4, $5)
                     RETURNING id`,
                    [convId, orgId, content, attachments_ids, dlp.has_pii ? JSON.stringify(dlp) : null],
                );
                userMsgId = u.rows[0].id;

                // Carrega KBs + skills do agente apenas se conversation
                // está vinculada. Fallback de KBs: se conversation não
                // tem KBs próprias, usamos do agente.
                if (conv.assistant_id) {
                    if (!conv.knowledge_base_ids || conv.knowledge_base_ids.length === 0) {
                        const akb = await client.query(
                            `SELECT knowledge_base_id
                               FROM assistant_knowledge_bases
                              WHERE assistant_id = $1::uuid AND org_id = $2
                                AND enabled = TRUE
                              ORDER BY priority NULLS LAST`,
                            [conv.assistant_id, orgId],
                        );
                        agentKbIds = akb.rows.map(r => r.knowledge_base_id);
                    }

                    // Reusa o hook de skills da 6a₂.B (mesma query) —
                    // monta o bloco "## Skills Aplicáveis" inline para
                    // injetar no system prompt do chat.
                    const skillsRes = await client.query(
                        `SELECT cs.id, cs.name, cs.skill_type, cs.instructions,
                                cs.skill_md_content
                           FROM catalog_skills cs
                           JOIN assistant_skill_bindings asb ON cs.id = asb.skill_id
                          WHERE asb.assistant_id = $1::uuid AND asb.org_id = $2
                            AND cs.is_active = TRUE AND asb.is_active = TRUE
                          ORDER BY cs.name`,
                        [conv.assistant_id, orgId],
                    );
                    if (skillsRes.rows.length > 0) {
                        for (const s of skillsRes.rows) {
                            if (s.skill_type === 'anthropic' && s.skill_md_content) {
                                const skillPath = `/mnt/skills/${orgId}/${s.id}`;
                                agentSkillBlocks.push(
                                    `### ${s.name}\n\n` +
                                    `Skill anthropic-style disponível em \`${skillPath}\`.\n\n` +
                                    `SKILL.md:\n${s.skill_md_content}`
                                );
                            } else {
                                agentSkillBlocks.push(
                                    `### ${s.name}\n${s.instructions ?? ''}`
                                );
                            }
                        }
                    }
                }
            });
        } catch (err) {
            if ((err as Error).message === 'NOT_FOUND') {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            throw err;
        }

        // 5. RAG retrieval (best-effort, off-thread of the SSE).
        // Prioridade: KBs explicitamente setadas na conversation > KBs
        // herdadas do agente. Vazio = no retrieval.
        const effectiveKbIds = (conv!.knowledge_base_ids && conv!.knowledge_base_ids.length > 0)
            ? conv!.knowledge_base_ids
            : agentKbIds;
        const ragChunks = await retrieveChunks(pgPool, orgId, content, effectiveKbIds, convId);

        // 6. Compose final messages array. Order:
        //   1. agent system_prompt (se tem agente vinculado)
        //   2. RAG context block (se houver hits)
        //   3. skills block (se agente tem skills vinculadas)
        //   4. history
        //   5. user message
        // Tudo isso prepended como uma única system message para LiteLLM
        // — alguns providers (Gemini) só aceitam um system role no
        // início do array, então concatenamos em vez de empilhar.
        const messages: Array<{ role: string; content: string }> = [];
        const systemParts: string[] = [];
        if (conv!.assistant_system_prompt) {
            systemParts.push(conv!.assistant_system_prompt);
        }
        if (ragChunks.length > 0) {
            const ctx = ragChunks
                .map((c, i) => `[Documento ${i + 1} · score ${c.score.toFixed(3)}]\n${c.content}`)
                .join('\n\n---\n\n');
            systemParts.push(
                '## Contexto recuperado da base de conhecimento da organização\n\n' +
                'Use estes documentos para fundamentar suas respostas — cite-os explicitamente quando aplicável:\n\n' +
                ctx
            );
        }
        if (agentSkillBlocks.length > 0) {
            systemParts.push(
                '## Skills Aplicáveis\n\n' + agentSkillBlocks.join('\n\n---\n\n')
            );
        }
        if (systemParts.length > 0) {
            messages.push({
                role: 'system',
                content: systemParts.join('\n\n---\n\n'),
            });
        }
        for (const m of history!) {
            messages.push({ role: m.role, content: m.content });
        }
        messages.push({ role: 'user', content });

        // Pre-flight LiteLLM upstream so connection errors surface as
        // JSON 502 instead of a half-open SSE the client has to abort.
        // 6c.B — model agora é optional no schema; fallback para o
        // default da conversation (que herdou do agente quando vinculada).
        const effectiveModel = model ?? conv!.default_model;
        let upstream: Response;
        try {
            upstream = await streamFromLitellm(effectiveModel, messages);
        } catch (err) {
            return reply.status(502).send({
                error: 'LLM upstream failed',
                detail: (err as Error).message,
            });
        }

        // 7. Hijack the response and start streaming.
        const corsHeaders = buildCorsHeaders(request.headers.origin);
        reply.hijack();
        reply.raw.writeHead(200, {
            ...corsHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const writeEnv = (envelope: Record<string, unknown>): boolean => {
            try {
                reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
                return true;
            } catch {
                return false;
            }
        };

        let assistantContent = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let finishReason: string | null = null;
        const startTs = Date.now();
        let aborted = false;
        request.raw.on('close', () => { aborted = true; });

        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (!aborted) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let nlIdx;
                while ((nlIdx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nlIdx).trim();
                    buffer = buffer.slice(nlIdx + 1);
                    if (!line) continue;
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') continue;
                    try {
                        const j = JSON.parse(payload);
                        const delta = j.choices?.[0]?.delta?.content;
                        if (delta) {
                            assistantContent += delta;
                            if (!writeEnv({ type: 'delta', content: delta })) {
                                aborted = true;
                                break;
                            }
                        }
                        const fr = j.choices?.[0]?.finish_reason;
                        if (fr) finishReason = fr;
                        if (j.usage) {
                            promptTokens = j.usage.prompt_tokens ?? promptTokens;
                            completionTokens = j.usage.completion_tokens ?? completionTokens;
                        }
                    } catch {
                        /* malformed chunk — skip */
                    }
                }
            }
        } catch (err) {
            writeEnv({ type: 'error', error: (err as Error).message });
        } finally {
            try { reader.releaseLock(); } catch { /* ignore */ }
        }

        // 8. Persist assistant message + bump conversation timestamps,
        // even on abort (we have a partial response that's still
        // useful to keep). If the abort happened before any tokens
        // arrived, skip the INSERT.
        let assistantMsgId: string | null = null;
        if (assistantContent.length > 0) {
            try {
                await withOrg(pgPool, orgId, async client => {
                    const r = await client.query(
                        `INSERT INTO chat_messages
                            (conversation_id, org_id, role, content, model,
                             tokens_in, tokens_out, latency_ms, finish_reason)
                         VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)
                         RETURNING id`,
                        [
                            convId, orgId, assistantContent, effectiveModel,
                            promptTokens || null,
                            completionTokens || null,
                            Date.now() - startTs,
                            finishReason ?? (aborted ? 'aborted' : 'stop'),
                        ],
                    );
                    assistantMsgId = r.rows[0].id;

                    // Bump last_message_at and (if first message) auto-
                    // generate a title from the user's prompt. Guarded
                    // by `title = 'Nova conversa'` so manual renames
                    // are preserved.
                    const autoTitle = content.length > 60
                        ? content.substring(0, 57) + '…'
                        : content;
                    await client.query(
                        `UPDATE chat_conversations
                            SET last_message_at = NOW(),
                                title = CASE WHEN title = 'Nova conversa' THEN $2 ELSE title END
                          WHERE id = $1::uuid AND org_id = $3`,
                        [convId, autoTitle, orgId],
                    );
                });
            } catch (err) {
                console.warn('[chat] persist assistant msg failed:', (err as Error).message);
            }
        }

        if (!aborted) {
            writeEnv({
                type: 'done',
                user_message_id: userMsgId!,
                assistant_message_id: assistantMsgId,
                tokens: { in: promptTokens, out: completionTokens },
                finish_reason: finishReason,
                latency_ms: Date.now() - startTs,
            });
        }
        try { reply.raw.end(); } catch { /* already ended */ }
    });

    // ──────────────────────────────────────────────────────────────────
    // POST /v1/chat/conversations/:id/attachments
    // ──────────────────────────────────────────────────────────────────
    //
    // Multipart upload of a file attached to the conversation. The
    // file lands at /var/govai/chat-attachments/<org>/<conv>/<sha>/<name>
    // and a row is created in chat_attachments. Text extraction is
    // performed on best-effort basis using document-extractor (PDF,
    // DOCX, TXT, MD).
    app.post('/v1/chat/conversations/:id/attachments', {
        preHandler: auth,
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const convId = String((request.params as any).id || '');
        const data = await request.file();
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        const buffer = await data.toBuffer();
        const sha = createHash('sha256').update(buffer).digest('hex');
        const safeName = path.basename(data.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = path.join(ATTACHMENTS_ROOT, orgId, convId, sha, safeName);
        await fs.mkdir(path.dirname(storagePath), { recursive: true });
        await fs.writeFile(storagePath, buffer);

        // Best-effort text extraction — ignore failures (image/pdf
        // without text layer / unsupported mime).
        let extractedText: string | null = null;
        try {
            const { extractContent } = await import('../lib/document-extractor');
            const ext = await extractContent(storagePath, data.mimetype);
            extractedText = ext.text.length > 100_000
                ? ext.text.substring(0, 100_000)
                : ext.text;
        } catch { /* not extractable, e.g. image */ }

        return await withOrg(pgPool, orgId, async client => {
            const r = await client.query(
                `INSERT INTO chat_attachments
                    (conversation_id, org_id, filename, mime_type, size_bytes,
                     sha256, storage_path, extracted_text)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING id, filename, mime_type, size_bytes, sha256, created_at`,
                [
                    convId, orgId, data.filename, data.mimetype,
                    buffer.length, sha, storagePath, extractedText,
                ],
            );
            return reply.status(201).send(r.rows[0]);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // GET /v1/chat/attachments/:id
    // ──────────────────────────────────────────────────────────────────
    app.get('/v1/chat/attachments/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const id = String((request.params as any).id || '');

        const row = await withOrg(pgPool, orgId, async client => {
            const r = await client.query(
                `SELECT filename, mime_type, storage_path, size_bytes
                   FROM chat_attachments WHERE id = $1::uuid AND org_id = $2`,
                [id, orgId],
            );
            return r.rows[0];
        });
        if (!row) {
            return reply.status(404).send({ error: 'attachment not found' });
        }
        try {
            await fs.access(row.storage_path);
        } catch {
            return reply.status(410).send({ error: 'file no longer available on disk' });
        }
        const safeName = path.basename(row.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        return reply
            .type(row.mime_type)
            .header('Content-Length', String(row.size_bytes))
            .header('Content-Disposition', `attachment; filename="${safeName}"`)
            .send(createReadStream(row.storage_path));
    });
}
