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

const conversationCreateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    mode: z.enum(['chat', 'code', 'cowork']).optional(),
    default_model: z.string().min(1).max(100).optional(),
    knowledge_base_ids: z.array(z.string().uuid()).max(20).optional(),
});

const conversationUpdateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    default_model: z.string().min(1).max(100).optional(),
    knowledge_base_ids: z.array(z.string().uuid()).max(20).optional(),
});

const sendMessageSchema = z.object({
    content: z.string().min(1).max(50_000),
    model: z.string().min(1).max(100),
    attachments_ids: z.array(z.string().uuid()).max(10).optional(),
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
 */
async function retrieveChunks(
    orgId: string,
    query: string,
    kbIds: string[],
): Promise<RetrievalChunk[]> {
    if (!kbIds || kbIds.length === 0) return [];
    try {
        const provider = getEmbeddingProvider();
        const [vec] = await provider.embed([query]);
        const top = parseInt(process.env.RAG_RETRIEVAL_TOP_K || '5', 10);
        const minScore = parseFloat(process.env.RAG_RETRIEVAL_MIN_SCORE || '0.6');
        const hits = await searchAcrossKnowledgeBases(orgId, kbIds, vec, {
            topK: top,
            minScore,
        });
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
            const r = await client.query(
                `SELECT id, title, mode, default_model, knowledge_base_ids,
                        pinned, archived, created_at, updated_at, last_message_at
                   FROM chat_conversations
                  WHERE ${where.join(' AND ')}
                  ORDER BY pinned DESC, last_message_at DESC NULLS LAST, created_at DESC
                  LIMIT $${params.length}`,
                params,
            );
            return reply.send({ conversations: r.rows });
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // POST /v1/chat/conversations
    // ──────────────────────────────────────────────────────────────────
    app.post('/v1/chat/conversations', { preHandler: auth }, async (request: any, reply) => {
        const { orgId, userId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const parse = conversationCreateSchema.safeParse(request.body ?? {});
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const body = parse.data;

        return await withOrg(pgPool, orgId, async client => {
            const r = await client.query(
                `INSERT INTO chat_conversations
                    (org_id, user_id, title, mode, default_model, knowledge_base_ids)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, title, mode, default_model, knowledge_base_ids,
                           pinned, archived, created_at, updated_at, last_message_at`,
                [
                    orgId,
                    userId ?? null,
                    body.title ?? 'Nova conversa',
                    body.mode ?? 'chat',
                    body.default_model ?? 'claude-sonnet-4-6',
                    body.knowledge_base_ids ?? [],
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
            const r = await client.query(
                `SELECT id, title, mode, default_model, knowledge_base_ids,
                        pinned, archived, created_at, updated_at, last_message_at, metadata
                   FROM chat_conversations
                  WHERE id = $1::uuid AND org_id = $2`,
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
                        finish_reason, tool_calls, attachments_ids, created_at
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

        // 1. DLP scan — reuse the document scanner so chat input applies
        // the same CPF/CNPJ/credit_card block policy as RAG upload.
        const dlp = scanDocumentForPII(content);
        if (dlp.action === 'block') {
            return reply.status(422).send({
                error: 'message blocked by DLP',
                hits: dlp.hits,
            });
        }

        // 2-4. Pre-stream DB work, all under one connection so RLS is
        // set once and the conversation lookup + history fetch + user
        // INSERT are consistent.
        let conv: { default_model: string; knowledge_base_ids: string[] };
        let history: Array<{ role: string; content: string }>;
        let userMsgId: string;

        try {
            await withOrg(pgPool, orgId, async client => {
                const c = await client.query(
                    `SELECT default_model, knowledge_base_ids
                       FROM chat_conversations
                      WHERE id = $1::uuid AND org_id = $2`,
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
            });
        } catch (err) {
            if ((err as Error).message === 'NOT_FOUND') {
                return reply.status(404).send({ error: 'conversation not found' });
            }
            throw err;
        }

        // 5. RAG retrieval (best-effort, off-thread of the SSE).
        const ragChunks = await retrieveChunks(orgId, content, conv!.knowledge_base_ids ?? []);

        // 6. Compose final messages array. System message carries any
        // RAG context — the assistant sees grounding documents BEFORE
        // the conversation history.
        const messages: Array<{ role: string; content: string }> = [];
        if (ragChunks.length > 0) {
            const ctx = ragChunks
                .map((c, i) => `[Documento ${i + 1} · score ${c.score.toFixed(3)}]\n${c.content}`)
                .join('\n\n---\n\n');
            messages.push({
                role: 'system',
                content:
                    'Contexto recuperado da base de conhecimento da organização — ' +
                    'use estes documentos para fundamentar suas respostas:\n\n' + ctx,
            });
        }
        for (const m of history!) {
            messages.push({ role: m.role, content: m.content });
        }
        messages.push({ role: 'user', content });

        // Pre-flight LiteLLM upstream so connection errors surface as
        // JSON 502 instead of a half-open SSE the client has to abort.
        let upstream: Response;
        try {
            upstream = await streamFromLitellm(model, messages);
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
                            convId, orgId, assistantContent, model,
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
