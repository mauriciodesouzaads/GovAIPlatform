import axios from 'axios';
import { Pool } from 'pg';
import { encode } from 'gpt-tokenizer';
import { EMBEDDING_DIMENSION } from './embedding-config';

/**
 * RAG Engine - Retrieval-Augmented Generation
 * 
 * Handles:
 * 1. Text chunking (splitting long documents)
 * 2. Embedding generation via Gemini API
 * 3. Vector similarity search in PostgreSQL (pgvector + HNSW)
 * 4. Token-aware context limiting (precise tokenizer via gpt-tokenizer)
 */

const CHUNK_SIZE = 500; // characters per chunk
const CHUNK_OVERLAP = 50;

// ---------------------------------------------------------------------------
// Token Estimation (precise via gpt-tokenizer)
// ---------------------------------------------------------------------------

/**
 * Model context window limits (safe budget = context window minus
 * a generous reserve for the user prompt, system prompt overhead,
 * and expected output tokens).
 * 
 * Budget formula: contextWindow - userPromptReserve - outputReserve - overhead
 */
const MODEL_TOKEN_BUDGETS: Record<string, number> = {
    'gemini/gemini-1.5-flash': 800_000,  // 1M context
    'gemini/gemini-1.5-pro': 800_000,  // 1M context
    'gemini/gemini-2.0-flash': 800_000,  // 1M context
    'gpt-4': 6_000,  // 8K context
    'gpt-4-turbo': 100_000,  // 128K context
    'gpt-4o': 100_000,  // 128K context
    'gpt-3.5-turbo': 12_000,  // 16K context
    'claude-3-opus': 150_000,  // 200K context, calibrated
    'claude-3.5-sonnet': 150_000,  // 200K context
    'claude-3-sonnet': 150_000,
    'claude-3-haiku': 150_000,
    'default': 4_000,  // Conservative fallback
};

/**
 * Precise token count using GPT-4o tokenizer (BPE).
 * 
 * gpt-tokenizer uses the cl100k_base encoding (same as GPT-4, GPT-4o).
 * For Gemini and Claude models, this slightly overestimates (they use
 * different tokenizers), which is the safe direction — we never exceed
 * the context window.
 * 
 * Performance: ~0.5ms for 500-char chunks, negligible overhead.
 */
export function estimateTokens(text: string): number {
    return encode(text).length;
}

/**
 * Get the safe RAG context token budget for a given model.
 */
export function getTokenBudget(model: string): number {
    return MODEL_TOKEN_BUDGETS[model] || MODEL_TOKEN_BUDGETS['default'];
}

// ---------------------------------------------------------------------------
// Text Chunking
// ---------------------------------------------------------------------------

/**
 * Split a long text into overlapping chunks for better retrieval.
 * Prefers to break at sentence boundaries (period + space) to avoid
 * cutting words or ideas mid-sentence.
 */
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);

        // Try to break at a sentence boundary ('. ') if not at end of text
        if (end < text.length) {
            const lastPeriod = text.lastIndexOf('. ', end);
            if (lastPeriod > start + chunkSize * 0.5) {
                end = lastPeriod + 2;
            }
        }

        chunks.push(text.substring(start, end).trim());

        // Ensure start always advances to avoid infinite loop
        const nextStart = end - overlap;
        start = nextStart > start ? nextStart : end;

        if (start >= text.length) break;
    }
    return chunks.filter(c => c.length > 0);
}

// ---------------------------------------------------------------------------
// Embedding Dimension Validation (P-10)
// ---------------------------------------------------------------------------

/**
 * Validates embedding dimension before INSERT or vector search.
 * Throws if dimension mismatch — prevents silent pgvector errors.
 */
export function validateEmbeddingDimension(embedding: number[]): void {
    if (embedding.length === 0) {
        throw new Error(
            `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got 0. Empty embedding invalid.`
        );
    }
    if (embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error(
            `Embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${embedding.length}. Check EMBEDDING_MODEL config.`
        );
    }
}

// ---------------------------------------------------------------------------
// Embedding Generation
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for a text using Gemini's Embedding API directly.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    // SEC-RAG-01: API key no header x-goog-api-key — nunca na URL
    // (URLs aparecem em logs de servidor, proxies, CDN e histório de browser)
    const response = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
        {
            content: { parts: [{ text }] },
            outputDimensionality: 768,
        },
        {
            timeout: 15000,
            headers: { 'x-goog-api-key': apiKey },
        }
    );

    return response.data.embedding.values;
}

// ---------------------------------------------------------------------------
// Document Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a document: chunk it, generate embeddings, and store in PostgreSQL.
 * GA-008: orgId is required for RLS isolation — uses a contextualised client.
 */
export async function ingestDocument(
    pool: Pool,
    kbId: string,
    orgId: string,
    content: string,
    metadata?: Record<string, any>
): Promise<{ chunksStored: number }> {
    const chunks = chunkText(content);
    let stored = 0;

    const client = await pool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const kbOwnership = await client.query(
            'SELECT 1 FROM knowledge_bases WHERE id = $1 AND org_id = $2 LIMIT 1',
            [kbId, orgId]
        );
        if ((kbOwnership.rowCount ?? 0) === 0) {
            throw new Error('Knowledge base não pertence à organização autenticada.');
        }
        for (const chunk of chunks) {
            try {
                const embedding = await generateEmbedding(chunk);
                validateEmbeddingDimension(embedding);
                const vectorStr = `[${embedding.join(',')}]`;

                await client.query(
                    `INSERT INTO documents (kb_id, org_id, content, metadata, embedding)
                     VALUES ($1, $2, $3, $4, $5::vector)`,
                    [kbId, orgId, chunk, JSON.stringify(metadata || {}), vectorStr]
                );
                stored++;
            } catch (error) {
                console.error(`Error embedding chunk: ${error}`);
            }
        }
    } finally {
        client.release();
    }

    return { chunksStored: stored };
}

// ---------------------------------------------------------------------------
// Similarity Search (basic)
// ---------------------------------------------------------------------------

/**
 * Search for relevant document chunks using cosine similarity.
 * GA-008: orgId required — uses contextualised client + filters by org_id.
 */
export async function searchSimilarChunks(
    pool: Pool,
    kbId: string,
    orgId: string,
    queryText: string,
    topK: number = 3
): Promise<{ content: string; similarity: number }[]> {
    const queryEmbedding = await generateEmbedding(queryText);
    validateEmbeddingDimension(queryEmbedding);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const client = await pool.connect();
    try {
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        const result = await client.query(
            `SELECT content, 1 - (embedding <=> $1::vector) AS similarity
             FROM documents
             WHERE kb_id = $2 AND org_id = $3
             ORDER BY embedding <=> $1::vector
             LIMIT $4`,
            [vectorStr, kbId, orgId, topK]
        );
        return result.rows;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Token-Aware Search (context window safe)
// ---------------------------------------------------------------------------

export interface TokenAwareSearchResult {
    context: string;
    chunksUsed: number;
    chunksAvailable: number;
    estimatedTokens: number;
    tokenBudget: number;
    truncated: boolean;
}

/**
 * Search for relevant chunks AND enforce a token budget.
 * 
 * Strategy:
 * 1. Fetch up to `maxCandidates` chunks (generous initial pool)
 * 2. Greedily add chunks in similarity order until budget is reached
 * 3. If a single chunk would bust the budget, truncate it to fit
 * 4. Return the assembled context string with metadata
 * 
 * @param pool          PostgreSQL pool
 * @param kbId          Knowledge base ID
 * @param queryText     User query (used for embedding search)
 * @param model         LiteLLM model name (to determine token budget)
 * @param maxCandidates Maximum chunks to fetch from DB (default 10)
 */
export async function searchWithTokenLimit(
    pool: Pool,
    kbId: string,
    orgId: string,
    queryText: string,
    model: string = 'default',
    maxCandidates: number = 10
): Promise<TokenAwareSearchResult> {
    const tokenBudget = getTokenBudget(model);
    const SEPARATOR = '\n---\n';
    const separatorTokens = estimateTokens(SEPARATOR);

    // Fetch a generous pool of candidates (GA-008: orgId scoped)
    const candidates = await searchSimilarChunks(pool, kbId, orgId, queryText, maxCandidates);

    const usedChunks: string[] = [];
    let currentTokens = 0;
    let truncated = false;

    for (const chunk of candidates) {
        const chunkTokens = estimateTokens(chunk.content);
        const additionalTokens = usedChunks.length > 0
            ? chunkTokens + separatorTokens
            : chunkTokens;

        if (currentTokens + additionalTokens <= tokenBudget) {
            // Chunk fits fully within budget
            usedChunks.push(chunk.content);
            currentTokens += additionalTokens;
        } else {
            // Chunk would exceed budget — try to truncate it to fit remaining space
            const remainingBudget = tokenBudget - currentTokens - (usedChunks.length > 0 ? separatorTokens : 0);
            if (remainingBudget > 100) { // Only truncate if we can fit at least ~100 tokens
                const maxChars = remainingBudget * 4; // reverse estimate: tokens → chars
                const truncatedContent = chunk.content.substring(0, maxChars).trim();
                // Try to break at a sentence boundary
                const lastPeriod = truncatedContent.lastIndexOf('. ');
                const cleanContent = lastPeriod > truncatedContent.length * 0.5
                    ? truncatedContent.substring(0, lastPeriod + 1)
                    : truncatedContent + '...';
                usedChunks.push(cleanContent);
                currentTokens += estimateTokens(cleanContent) + (usedChunks.length > 1 ? separatorTokens : 0);
                truncated = true;
            }
            break; // Budget exhausted
        }
    }

    return {
        context: usedChunks.join(SEPARATOR),
        chunksUsed: usedChunks.length,
        chunksAvailable: candidates.length,
        estimatedTokens: currentTokens,
        tokenBudget,
        truncated,
    };
}
