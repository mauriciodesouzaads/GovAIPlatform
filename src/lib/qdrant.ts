/**
 * Qdrant client + per-org collection helpers — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * Wraps @qdrant/js-client-rest with the GovAI conventions:
 *
 *   1. ONE collection per (org, KB) — `govai_org_<uuid_compact>_<kb_compact>`.
 *      Multi-tenant correctness lives in the collection name itself, not
 *      in a query filter, so a misconfigured search never crosses orgs.
 *   2. Point IDs are UUIDs and equal the document_chunks.id, so DB ↔
 *      Qdrant joins are O(1) without a translation table.
 *   3. Idempotent collection creation: ensureCollection() is safe to call
 *      on every upload (it short-circuits when the collection already
 *      exists).
 *   4. Cosine distance everywhere — both Gemini and OpenAI return
 *      normalized embeddings; the mock provider also L2-normalizes.
 */

import { QdrantClient } from '@qdrant/js-client-rest';

let _client: QdrantClient | null = null;

export function getQdrantClient(): QdrantClient {
    if (_client) return _client;
    _client = new QdrantClient({
        url: process.env.QDRANT_URL || 'http://qdrant:6333',
        apiKey: process.env.QDRANT_API_KEY,
        // The default port (6333) is REST. The grpc transport on 6334
        // is faster but the REST path is sufficient for our throughput
        // and avoids an extra dep on @grpc + protobuf for qdrant.
    });
    return _client;
}

/**
 * Stable per-(org, KB) collection name. Decided at the lib level so all
 * callers — uploads, retrieval, deletions — derive the same string.
 *
 * The legacy 094 backfill formula is identical: this function is the
 * single source of truth.
 */
export function collectionNameFor(orgId: string, knowledgeBaseId: string): string {
    const prefix = process.env.QDRANT_COLLECTION_PREFIX || 'govai_org';
    const orgCompact = orgId.replace(/-/g, '');
    const kbCompact = knowledgeBaseId.replace(/-/g, '');
    return `${prefix}_${orgCompact}_${kbCompact}`;
}

/**
 * Create the collection if it doesn't exist. Idempotent. The dimension
 * is recorded once at creation time; later providers must use the same
 * dim or the upsert will reject.
 */
export async function ensureCollection(
    orgId: string,
    knowledgeBaseId: string,
    dimensions: number,
): Promise<string> {
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    const exists = await client.collectionExists(name);
    if (exists.exists) return name;
    await client.createCollection(name, {
        vectors: { size: dimensions, distance: 'Cosine' },
        // on_disk_payload keeps the JSON sidecar off the hot path; the
        // vector itself stays in memory which is what makes search fast.
        on_disk_payload: true,
    });
    return name;
}

/**
 * Drop the collection (used when a KB is deleted).
 */
export async function dropCollection(
    orgId: string,
    knowledgeBaseId: string,
): Promise<void> {
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    const exists = await client.collectionExists(name);
    if (!exists.exists) return;
    await client.deleteCollection(name);
}

export interface QdrantPointPayload {
    document_id: string;
    knowledge_base_id: string;
    chunk_index: number;
    content: string;            // full chunk text — needed at retrieval time
    page_number?: number;
    metadata?: Record<string, unknown>;
}

export interface QdrantPoint {
    id: string;
    vector: number[];
    payload: QdrantPointPayload;
}

/**
 * Batched upsert. Qdrant accepts up to a few thousand points per call
 * but staying under 100 keeps the HTTP body small and lets us bail
 * early on a partial failure without re-indexing a whole document.
 */
export async function upsertPoints(
    orgId: string,
    knowledgeBaseId: string,
    points: QdrantPoint[],
): Promise<void> {
    if (points.length === 0) return;
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        // Cast: the Qdrant client's PointStruct payload type is
        // Record<string, unknown>, our QdrantPointPayload is the same
        // shape but with named keys. The cast is safe — the wire
        // format is JSON.
        await client.upsert(name, {
            points: batch as unknown as Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>,
            wait: true,
        });
    }
}

export interface QdrantHit {
    id: string;
    score: number;
    payload: QdrantPointPayload;
}

/**
 * Retrieval. Searches across one (org, KB) collection. The retrieval
 * hook in dispatchWorkItem may need to query MULTIPLE KBs in a single
 * call — see searchAcrossKnowledgeBases below.
 */
export async function searchPoints(
    orgId: string,
    knowledgeBaseId: string,
    queryVector: number[],
    options: { topK: number; minScore: number },
): Promise<QdrantHit[]> {
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    // collectionExists check first so a never-uploaded KB returns []
    // instead of throwing 404.
    const exists = await client.collectionExists(name);
    if (!exists.exists) return [];

    const result = await client.search(name, {
        vector: queryVector,
        limit: options.topK,
        score_threshold: options.minScore,
        with_payload: true,
    });
    return result.map(r => ({
        id: String(r.id),
        score: r.score,
        payload: r.payload as unknown as QdrantPointPayload,
    }));
}

/**
 * Search every KB in turn and merge results, sorted by score desc.
 * Used by the runtime hook when an assistant has multiple KBs linked.
 */
export async function searchAcrossKnowledgeBases(
    orgId: string,
    knowledgeBaseIds: string[],
    queryVector: number[],
    options: { topK: number; minScore: number },
): Promise<QdrantHit[]> {
    if (knowledgeBaseIds.length === 0) return [];
    // Per-KB topK is the global topK — over-fetching across KBs and
    // truncating after the merge gives us the best top-K overall.
    const perKb = await Promise.all(
        knowledgeBaseIds.map(kbId =>
            searchPoints(orgId, kbId, queryVector, options).catch(err => {
                console.warn(`[qdrant] search on kb=${kbId} failed:`, (err as Error).message);
                return [] as QdrantHit[];
            }),
        ),
    );
    const merged = perKb.flat().sort((a, b) => b.score - a.score);
    return merged.slice(0, options.topK);
}

/**
 * Delete all points for a given document. Called on document delete +
 * before re-indexing on a re-upload.
 */
export async function deletePointsByDocument(
    orgId: string,
    knowledgeBaseId: string,
    documentId: string,
): Promise<void> {
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    const exists = await client.collectionExists(name);
    if (!exists.exists) return;
    await client.delete(name, {
        filter: {
            must: [{ key: 'document_id', match: { value: documentId } }],
        },
        wait: true,
    });
}

/** Sanity helper: count points in a collection (used by reality-check). */
export async function countPoints(
    orgId: string,
    knowledgeBaseId: string,
): Promise<number> {
    const client = getQdrantClient();
    const name = collectionNameFor(orgId, knowledgeBaseId);
    const exists = await client.collectionExists(name);
    if (!exists.exists) return 0;
    const info = await client.getCollection(name);
    return Number(info.points_count ?? 0);
}
