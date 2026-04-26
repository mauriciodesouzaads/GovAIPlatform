/**
 * Knowledge Bases / Documents / Embeddings — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * REST surface for the new RAG pipeline. The legacy /v1/admin/assistants
 * RAG fields (knowledge_bases.assistant_id 1:1, documents.embedding via
 * pgvector) keep working untouched — those rows just lack the new
 * extracted_text / sha256 / dlp_scan_result columns until they're
 * re-uploaded through this surface.
 *
 * Endpoint map (all auth via JWT preHandler, all tenant-isolated via RLS):
 *
 *   Knowledge Bases
 *     POST   /v1/admin/knowledge-bases
 *     GET    /v1/admin/knowledge-bases
 *     GET    /v1/admin/knowledge-bases/:id
 *     PATCH  /v1/admin/knowledge-bases/:id
 *     DELETE /v1/admin/knowledge-bases/:id
 *
 *   Documents (multipart upload + lifecycle)
 *     POST   /v1/admin/knowledge-bases/:id/documents       (multipart)
 *     GET    /v1/admin/knowledge-bases/:id/documents
 *     GET    /v1/admin/documents/:id
 *     GET    /v1/admin/documents/:id/chunks
 *     DELETE /v1/admin/documents/:id
 *
 *   Search / retrieval
 *     POST   /v1/admin/knowledge-bases/:id/search
 *     POST   /v1/admin/embeddings/search        (cross-KB)
 *
 *   Assistant ↔ KB linking
 *     PUT    /v1/admin/assistants/:id/knowledge-bases
 *     GET    /v1/admin/assistants/:id/knowledge-bases
 *
 * Pipeline (upload):
 *   1. Stream the upload to disk (sha256-keyed) under RAG_STORAGE_PATH
 *   2. Insert documents row (status='pending')
 *   3. Run the inline processor: extract → DLP → chunk → embed → upsert
 *      (we run it inline because BullMQ isn't yet wired for RAG; if
 *      needed later, swap the call to a queue.add() — handler signature
 *      is identical)
 *   4. Mark status='ready' on success, 'failed' with extraction_error on err
 */

import { FastifyInstance } from 'fastify';
import { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { randomUUID, createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import {
    getEmbeddingProvider,
    type EmbeddingProvider,
} from '../lib/embeddings';
import {
    ensureCollection,
    upsertPoints,
    searchPoints,
    searchAcrossKnowledgeBases,
    deletePointsByDocument,
    dropCollection,
    collectionNameFor,
    type QdrantPoint,
} from '../lib/qdrant';
import {
    extractContent,
    isSupportedMime,
    SUPPORTED_MIMES,
} from '../lib/document-extractor';
import { chunkByTokens } from '../lib/rag-chunker';
import { scanDocumentForPII, type DLPDocumentResult } from '../lib/dlp-document-scanner';

// ── Schemas ────────────────────────────────────────────────────────────────

const UUID_LOOSE = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'malformed uuid',
);

const createKbSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    embedding_provider: z.enum(['gemini', 'openai', 'mock']).optional(),
    embedding_model: z.string().max(100).optional(),
    embedding_dim: z.number().int().min(64).max(4096).optional(),
    chunk_size_tokens: z.number().int().min(64).max(4000).optional(),
    chunk_overlap_tokens: z.number().int().min(0).max(2000).optional(),
});

const patchKbSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    status: z.enum(['active', 'archived']).optional(),
});

const searchSchema = z.object({
    query: z.string().min(1).max(8000),
    top_k: z.number().int().min(1).max(50).optional(),
    min_score: z.number().min(0).max(1).optional(),
});

const crossKbSearchSchema = searchSchema.extend({
    knowledge_base_ids: z.array(UUID_LOOSE).min(1).max(10),
});

const linkKbsSchema = z.object({
    knowledge_base_ids: z.array(UUID_LOOSE).max(20),
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function withOrg<T>(pool: Pool, orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
        await c.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        return await fn(c);
    } finally {
        await c.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        c.release();
    }
}

interface KbRow {
    id: string;
    org_id: string;
    name: string;
    description: string | null;
    embedding_provider: string;
    embedding_model: string;
    embedding_dim: number;
    chunk_size_tokens: number;
    chunk_overlap_tokens: number;
    status: string;
    qdrant_collection_name: string;
    document_count: number;
    chunk_count: number;
    total_size_bytes: number;
    created_at: Date;
    updated_at: Date;
}

const KB_COLS = `
    id, org_id, name, description,
    embedding_provider, embedding_model, embedding_dim,
    chunk_size_tokens, chunk_overlap_tokens,
    status, qdrant_collection_name,
    document_count, chunk_count, total_size_bytes,
    created_at, updated_at
`;

function rowToKb(r: KbRow) {
    return {
        id: r.id,
        name: r.name,
        description: r.description,
        embedding_provider: r.embedding_provider,
        embedding_model: r.embedding_model,
        embedding_dim: r.embedding_dim,
        chunk_size_tokens: r.chunk_size_tokens,
        chunk_overlap_tokens: r.chunk_overlap_tokens,
        status: r.status,
        qdrant_collection_name: r.qdrant_collection_name,
        document_count: Number(r.document_count),
        chunk_count: Number(r.chunk_count),
        total_size_bytes: Number(r.total_size_bytes),
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    };
}

// ── Pipeline: upload → extract → DLP → chunk → embed → upsert ──────────────

async function processDocumentInline(params: {
    pool: Pool;
    orgId: string;
    documentId: string;
    knowledgeBaseId: string;
    filePath: string;
    mimeType: string;
    provider: EmbeddingProvider;
    chunkSize: number;
    chunkOverlap: number;
    expectedDim: number;
}): Promise<void> {
    const { pool, orgId, documentId, knowledgeBaseId, filePath, mimeType,
            provider, chunkSize, chunkOverlap, expectedDim } = params;

    const updateStatus = (status: string, extra?: string) =>
        withOrg(pool, orgId, c =>
            c.query(
                `UPDATE documents
                    SET extraction_status = $1,
                        extraction_error = $2
                  WHERE id = $3 AND org_id = $4`,
                [status, extra ?? null, documentId, orgId],
            ),
        );

    try {
        await updateStatus('extracting');
        const content = await extractContent(filePath, mimeType);
        if (content.char_count === 0) {
            await updateStatus('failed', 'extraction returned empty text (scanned PDF without OCR?)');
            return;
        }

        // DLP — block on hard PII (CPF/CNPJ/credit card).
        const dlp: DLPDocumentResult = scanDocumentForPII(content.text);
        await withOrg(pool, orgId, c =>
            c.query(
                `UPDATE documents
                    SET dlp_scan_result = $1::jsonb,
                        page_count = $2,
                        extracted_text_chars = $3
                  WHERE id = $4 AND org_id = $5`,
                [JSON.stringify(dlp), content.page_count ?? null,
                 content.char_count, documentId, orgId],
            ),
        );
        if (dlp.action === 'block') {
            const reason = `DLP block — ${dlp.hits.map(h => `${h.type}:${h.count}`).join(', ')}`;
            await updateStatus('failed', reason);
            return;
        }

        // Chunk
        await updateStatus('chunking');
        const chunks = chunkByTokens(content.text, {
            chunkSizeTokens: chunkSize,
            chunkOverlapTokens: chunkOverlap,
        });
        if (chunks.length === 0) {
            await updateStatus('failed', 'chunker produced 0 chunks');
            return;
        }

        // Embed + persist chunk metadata + upsert points to Qdrant.
        await updateStatus('embedding');
        await ensureCollection(orgId, knowledgeBaseId, expectedDim);

        const batchSize = 32;
        const points: QdrantPoint[] = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const vectors = await provider.embed(batch.map(c => c.content));
            for (let j = 0; j < batch.length; j++) {
                const chunkId = randomUUID();
                const chunk = batch[j];
                const vec = vectors[j];
                if (vec.length !== expectedDim) {
                    throw new Error(
                        `embedding dim mismatch: expected ${expectedDim}, got ${vec.length}`,
                    );
                }
                const contentHash = createHash('sha256').update(chunk.content).digest('hex');
                await withOrg(pool, orgId, c =>
                    c.query(
                        `INSERT INTO document_chunks
                            (id, org_id, document_id, knowledge_base_id,
                             chunk_index, content_preview, content_hash,
                             token_count, qdrant_point_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $1)`,
                        [chunkId, orgId, documentId, knowledgeBaseId,
                         chunk.index, chunk.content.substring(0, 200),
                         contentHash, chunk.token_count],
                    ),
                );
                points.push({
                    id: chunkId,
                    vector: vec,
                    payload: {
                        document_id: documentId,
                        knowledge_base_id: knowledgeBaseId,
                        chunk_index: chunk.index,
                        content: chunk.content,
                    },
                });
            }
        }
        await upsertPoints(orgId, knowledgeBaseId, points);

        // Final status + counters bump
        await withOrg(pool, orgId, async c => {
            await c.query(
                `UPDATE documents
                    SET extraction_status = 'ready',
                        chunk_count = $1,
                        indexed_at = NOW()
                  WHERE id = $2 AND org_id = $3`,
                [chunks.length, documentId, orgId],
            );
            await c.query(
                `UPDATE knowledge_bases
                    SET document_count = (
                            SELECT COUNT(*) FROM documents
                             WHERE knowledge_base_id = $1
                               AND extraction_status = 'ready'
                        ),
                        chunk_count = (
                            SELECT COALESCE(SUM(chunk_count), 0) FROM documents
                             WHERE knowledge_base_id = $1
                               AND extraction_status = 'ready'
                        )
                  WHERE id = $1`,
                [knowledgeBaseId],
            );
        });
    } catch (err) {
        await updateStatus('failed', (err as Error).message).catch(() => {});
        throw err;
    }
}

// ───────────────────────────────────────────────────────────────────────────

export async function knowledgeRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any },
) {
    const { pgPool, requireRole } = opts;
    const readAuth = requireRole(['admin', 'operator', 'auditor', 'dpo']);
    const writeAuth = requireRole(['admin', 'operator']);

    // ── POST /v1/admin/knowledge-bases ───────────────────────────────
    app.post('/v1/admin/knowledge-bases', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId, userId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const parse = createKbSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const b = parse.data;

        const provider = b.embedding_provider ?? 'gemini';
        const dim = b.embedding_dim ?? (provider === 'openai' ? 1536 : 768);
        const model = b.embedding_model ?? (
            provider === 'openai' ? 'text-embedding-3-small' :
            provider === 'gemini' ? 'gemini-embedding-001' :
            'mock-deterministic-v1'
        );

        const id = randomUUID();
        const collectionName = collectionNameFor(orgId, id);
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `INSERT INTO knowledge_bases (
                    id, org_id, name, description,
                    embedding_provider, embedding_model, embedding_dim,
                    chunk_size_tokens, chunk_overlap_tokens,
                    status, qdrant_collection_name, created_by
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11)
                 RETURNING ${KB_COLS}`,
                [
                    id, orgId, b.name, b.description ?? null,
                    provider, model, dim,
                    b.chunk_size_tokens ?? parseInt(process.env.RAG_CHUNK_SIZE_TOKENS || '512', 10),
                    b.chunk_overlap_tokens ?? parseInt(process.env.RAG_CHUNK_OVERLAP_TOKENS || '64', 10),
                    collectionName, userId ?? null,
                ],
            ),
        );
        return reply.status(201).send(rowToKb(result.rows[0]));
    });

    // ── GET /v1/admin/knowledge-bases ────────────────────────────────
    app.get('/v1/admin/knowledge-bases', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const status = (req.query?.status as string) || 'active';
        const limit = Math.min(200, parseInt((req.query?.limit as string) || '50', 10));
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT ${KB_COLS} FROM knowledge_bases
                  WHERE org_id = $1 AND status = $2
                  ORDER BY created_at DESC
                  LIMIT $3`,
                [orgId, status, limit],
            ),
        );
        return reply.send({ items: result.rows.map(rowToKb), total: result.rows.length });
    });

    // ── GET /v1/admin/knowledge-bases/:id ────────────────────────────
    app.get('/v1/admin/knowledge-bases/:id', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT ${KB_COLS} FROM knowledge_bases
                  WHERE id = $1::uuid AND org_id = $2`,
                [id, orgId],
            ),
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'kb not found' });
        return reply.send(rowToKb(result.rows[0]));
    });

    // ── PATCH /v1/admin/knowledge-bases/:id ──────────────────────────
    app.patch('/v1/admin/knowledge-bases/:id', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const parse = patchKbSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const b = parse.data;
        const sets: string[] = [];
        const vals: any[] = [];
        const push = (col: string, v: any) => { sets.push(`${col} = $${sets.length + 1}`); vals.push(v); };
        if (b.name !== undefined) push('name', b.name);
        if (b.description !== undefined) push('description', b.description);
        if (b.status !== undefined) push('status', b.status);
        if (sets.length === 0) return reply.status(400).send({ error: 'no fields to update' });
        vals.push(id, orgId);
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `UPDATE knowledge_bases SET ${sets.join(', ')}
                  WHERE id = $${sets.length + 1}::uuid AND org_id = $${sets.length + 2}
                  RETURNING ${KB_COLS}`,
                vals,
            ),
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'kb not found' });
        return reply.send(rowToKb(result.rows[0]));
    });

    // ── DELETE /v1/admin/knowledge-bases/:id ─────────────────────────
    app.delete('/v1/admin/knowledge-bases/:id', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `DELETE FROM knowledge_bases WHERE id = $1::uuid AND org_id = $2 RETURNING id`,
                [id, orgId],
            ),
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'kb not found' });
        // Drop the Qdrant collection AFTER the DB cascades. Best-effort:
        // a Qdrant outage shouldn't block the metadata cleanup.
        try { await dropCollection(orgId, id); }
        catch (err) { req.log?.warn?.({ err }, '[rag] dropCollection failed'); }
        return reply.send({ deleted: true });
    });

    // ── POST /v1/admin/knowledge-bases/:id/documents (multipart) ─────
    app.post('/v1/admin/knowledge-bases/:id/documents', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId, userId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id: kbId } = req.params as { id: string };

        const data = await req.file();
        if (!data) return reply.status(400).send({ error: 'no file uploaded' });
        if (!isSupportedMime(data.mimetype)) {
            return reply.status(415).send({
                error: `unsupported mime: ${data.mimetype}`,
                supported: SUPPORTED_MIMES,
            });
        }

        const buf = await data.toBuffer();
        const sha = createHash('sha256').update(buf).digest('hex');
        const storageBase = process.env.RAG_STORAGE_PATH || '/var/govai/rag-storage';
        const storageDir = path.join(storageBase, orgId, sha);
        const safeName = data.filename.replace(/[^\w.\- ]+/g, '_');
        const storagePath = path.join(storageDir, safeName);
        await fs.mkdir(storageDir, { recursive: true });
        await fs.writeFile(storagePath, buf);

        // Validate KB exists + belongs to org; capture chunking config.
        const kbRow = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT id, embedding_dim, chunk_size_tokens, chunk_overlap_tokens
                   FROM knowledge_bases WHERE id = $1::uuid AND org_id = $2`,
                [kbId, orgId],
            ),
        );
        if (kbRow.rows.length === 0) return reply.status(404).send({ error: 'kb not found' });
        const kb = kbRow.rows[0];

        // Insert document row. (knowledge_base_id, sha256) is unique →
        // a re-upload of the exact same file rejects with 409.
        const docId = randomUUID();
        try {
            await withOrg(pgPool, orgId, c =>
                c.query(
                    `INSERT INTO documents (
                        id, org_id, kb_id, knowledge_base_id, content,
                        filename, mime_type, size_bytes, sha256, storage_path,
                        extraction_status, uploaded_by
                     ) VALUES ($1, $2, $3, $3, '',
                               $4, $5, $6, $7, $8,
                               'pending', $9)`,
                    [docId, orgId, kbId, data.filename, data.mimetype,
                     buf.length, sha, storagePath, userId ?? null],
                ),
            );
        } catch (err: any) {
            if (String(err.code) === '23505') {
                return reply.status(409).send({ error: 'document with this sha256 already exists in KB' });
            }
            throw err;
        }
        // Bump KB total_size + document count optimistically; the
        // pipeline corrects the chunk count when it lands.
        await withOrg(pgPool, orgId, c =>
            c.query(
                `UPDATE knowledge_bases
                    SET total_size_bytes = total_size_bytes + $1
                  WHERE id = $2`,
                [buf.length, kbId],
            ),
        );

        // Run inline pipeline (no queue yet — see file-level comment).
        // We don't await the pipeline before responding — the route
        // returns 202 + work continues in the background. Errors are
        // surfaced via documents.extraction_status='failed'.
        const provider = getEmbeddingProvider();
        if (provider.dimensions !== kb.embedding_dim) {
            // KB dim was set when it was created; switching providers
            // mid-life would corrupt the collection. Fail fast.
            await withOrg(pgPool, orgId, c =>
                c.query(
                    `UPDATE documents SET extraction_status='failed',
                            extraction_error=$1 WHERE id=$2`,
                    [`provider dim ${provider.dimensions} ≠ kb dim ${kb.embedding_dim}`, docId],
                ),
            );
            return reply.status(400).send({
                error: 'embedding dim mismatch — recreate KB or switch provider',
            });
        }

        processDocumentInline({
            pool: pgPool,
            orgId,
            documentId: docId,
            knowledgeBaseId: kbId,
            filePath: storagePath,
            mimeType: data.mimetype,
            provider,
            chunkSize: kb.chunk_size_tokens,
            chunkOverlap: kb.chunk_overlap_tokens,
            expectedDim: kb.embedding_dim,
        }).catch(err => {
            req.log?.error?.({ err }, '[rag] processDocumentInline failed');
        });

        return reply.status(202).send({
            document_id: docId,
            status: 'pending',
            sha256: sha,
            size_bytes: buf.length,
        });
    });

    // ── GET /v1/admin/knowledge-bases/:id/documents ──────────────────
    app.get('/v1/admin/knowledge-bases/:id/documents', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id: kbId } = req.params as { id: string };
        const status = req.query?.status as string | undefined;
        const limit = Math.min(200, parseInt((req.query?.limit as string) || '50', 10));
        const params: any[] = [kbId, orgId, limit];
        let where = 'knowledge_base_id = $1::uuid AND org_id = $2';
        if (status) { params.splice(2, 0, status); where += ` AND extraction_status = $3`; }
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT id, filename, mime_type, size_bytes, sha256,
                        extraction_status, extraction_error,
                        page_count, extracted_text_chars, chunk_count,
                        dlp_scan_result, uploaded_at, indexed_at
                   FROM documents
                  WHERE ${where}
                  ORDER BY uploaded_at DESC
                  LIMIT $${params.length}`,
                params,
            ),
        );
        return reply.send({
            items: result.rows.map((r: any) => ({
                ...r,
                size_bytes: Number(r.size_bytes ?? 0),
                uploaded_at: r.uploaded_at?.toISOString?.() ?? r.uploaded_at,
                indexed_at: r.indexed_at?.toISOString?.() ?? r.indexed_at,
            })),
        });
    });

    // ── GET /v1/admin/documents/:id ──────────────────────────────────
    app.get('/v1/admin/documents/:id', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT id, knowledge_base_id, filename, mime_type, size_bytes, sha256,
                        storage_path, extraction_status, extraction_error,
                        page_count, extracted_text_chars, chunk_count,
                        dlp_scan_result, uploaded_at, indexed_at
                   FROM documents
                  WHERE id = $1::uuid AND org_id = $2`,
                [id, orgId],
            ),
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'document not found' });
        const r: any = result.rows[0];
        return reply.send({
            ...r,
            size_bytes: Number(r.size_bytes ?? 0),
            uploaded_at: r.uploaded_at?.toISOString?.() ?? r.uploaded_at,
            indexed_at: r.indexed_at?.toISOString?.() ?? r.indexed_at,
        });
    });

    // ── GET /v1/admin/documents/:id/chunks ───────────────────────────
    app.get('/v1/admin/documents/:id/chunks', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const limit = Math.min(200, parseInt((req.query?.limit as string) || '50', 10));
        const offset = parseInt((req.query?.offset as string) || '0', 10);
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT id, chunk_index, page_number, content_preview,
                        token_count, content_hash
                   FROM document_chunks
                  WHERE document_id = $1::uuid AND org_id = $2
                  ORDER BY chunk_index ASC
                  LIMIT $3 OFFSET $4`,
                [id, orgId, limit, offset],
            ),
        );
        return reply.send({ items: result.rows, limit, offset });
    });

    // ── DELETE /v1/admin/documents/:id ───────────────────────────────
    app.delete('/v1/admin/documents/:id', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id } = req.params as { id: string };
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `DELETE FROM documents WHERE id = $1::uuid AND org_id = $2
                  RETURNING knowledge_base_id, storage_path, size_bytes`,
                [id, orgId],
            ),
        );
        if (result.rows.length === 0) return reply.status(404).send({ error: 'document not found' });
        const r = result.rows[0];
        // Cascade: Qdrant points + storage file. Best-effort.
        try { await deletePointsByDocument(orgId, r.knowledge_base_id, id); }
        catch (err) { req.log?.warn?.({ err }, '[rag] deletePointsByDocument failed'); }
        try { if (r.storage_path) await fs.unlink(r.storage_path); }
        catch { /* file already gone — fine */ }
        // Bump KB counters down.
        await withOrg(pgPool, orgId, c =>
            c.query(
                `UPDATE knowledge_bases
                    SET total_size_bytes = GREATEST(0, total_size_bytes - $1),
                        document_count = (SELECT COUNT(*) FROM documents
                                           WHERE knowledge_base_id = $2
                                             AND extraction_status = 'ready'),
                        chunk_count = (SELECT COALESCE(SUM(chunk_count),0)
                                         FROM documents
                                        WHERE knowledge_base_id = $2
                                          AND extraction_status = 'ready')
                  WHERE id = $2`,
                [Number(r.size_bytes ?? 0), r.knowledge_base_id],
            ),
        );
        return reply.send({ deleted: true });
    });

    // ── POST /v1/admin/knowledge-bases/:id/search ────────────────────
    app.post('/v1/admin/knowledge-bases/:id/search', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id: kbId } = req.params as { id: string };
        const parse = searchSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const provider = getEmbeddingProvider();
        const [vec] = await provider.embed([parse.data.query]);
        const hits = await searchPoints(orgId, kbId, vec, {
            topK: parse.data.top_k ?? parseInt(process.env.RAG_RETRIEVAL_TOP_K || '5', 10),
            minScore: parse.data.min_score ?? parseFloat(process.env.RAG_RETRIEVAL_MIN_SCORE || '0.6'),
        });
        return reply.send({ results: hits });
    });

    // ── POST /v1/admin/embeddings/search (cross-KB) ──────────────────
    app.post('/v1/admin/embeddings/search', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const parse = crossKbSearchSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        const provider = getEmbeddingProvider();
        const [vec] = await provider.embed([parse.data.query]);
        const hits = await searchAcrossKnowledgeBases(orgId, parse.data.knowledge_base_ids, vec, {
            topK: parse.data.top_k ?? parseInt(process.env.RAG_RETRIEVAL_TOP_K || '5', 10),
            minScore: parse.data.min_score ?? parseFloat(process.env.RAG_RETRIEVAL_MIN_SCORE || '0.6'),
        });
        return reply.send({ results: hits });
    });

    // ── PUT /v1/admin/assistants/:id/knowledge-bases ─────────────────
    app.put('/v1/admin/assistants/:id/knowledge-bases', { preHandler: writeAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id: assistantId } = req.params as { id: string };
        const parse = linkKbsSchema.safeParse(req.body);
        if (!parse.success) {
            return reply.status(400).send({ error: 'invalid body', details: parse.error.format() });
        }
        await withOrg(pgPool, orgId, async c => {
            // Confirm assistant exists in org
            const a = await c.query(
                `SELECT id FROM assistants WHERE id = $1::uuid AND org_id = $2`,
                [assistantId, orgId],
            );
            if (a.rows.length === 0) {
                throw Object.assign(new Error('assistant not found'), { httpStatus: 404 });
            }
            await c.query(
                `DELETE FROM assistant_knowledge_bases WHERE assistant_id = $1`,
                [assistantId],
            );
            for (const kbId of parse.data.knowledge_base_ids) {
                await c.query(
                    `INSERT INTO assistant_knowledge_bases
                        (assistant_id, knowledge_base_id, org_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT DO NOTHING`,
                    [assistantId, kbId, orgId],
                );
            }
        }).catch(err => {
            if (err.httpStatus === 404) return reply.status(404).send({ error: err.message });
            throw err;
        });
        return reply.send({ assistant_id: assistantId, linked: parse.data.knowledge_base_ids.length });
    });

    // ── GET /v1/admin/assistants/:id/knowledge-bases ─────────────────
    app.get('/v1/admin/assistants/:id/knowledge-bases', { preHandler: readAuth }, async (req: any, reply) => {
        const { orgId } = req.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente' });
        const { id: assistantId } = req.params as { id: string };
        const result = await withOrg(pgPool, orgId, c =>
            c.query(
                `SELECT kb.${KB_COLS.split(',').map(s => s.trim()).join(', kb.')}
                   FROM assistant_knowledge_bases akb
                   JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id
                  WHERE akb.assistant_id = $1::uuid AND akb.org_id = $2 AND akb.enabled = TRUE
                  ORDER BY akb.priority ASC, kb.created_at DESC`,
                [assistantId, orgId],
            ),
        );
        return reply.send(result.rows.map(rowToKb));
    });
}
