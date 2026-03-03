import axios from 'axios';
import { Pool } from 'pg';

/**
 * RAG Engine - Retrieval-Augmented Generation
 * 
 * Handles:
 * 1. Text chunking (splitting long documents)
 * 2. Embedding generation via Gemini API
 * 3. Vector similarity search in PostgreSQL (pgvector + HNSW)
 * 4. Token-aware context limiting (prevents exceeding model context window)
 */

const CHUNK_SIZE = 500; // characters per chunk
const CHUNK_OVERLAP = 50;

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

/**
 * Model context window limits (safe budget = context window minus
 * a generous reserve for the user prompt, system prompt overhead,
 * and expected output tokens).
 * 
 * Budget formula: contextWindow - userPromptReserve - outputReserve - overhead
 */
const MODEL_TOKEN_BUDGETS: Record<string, number> = {
    'gemini/gemini-1.5-flash': 800_000,  // 1M context, very generous
    'gemini/gemini-1.5-pro': 800_000,  // 1M context
    'gemini/gemini-2.0-flash': 800_000,  // 1M context
    'gpt-4': 6_000,  // 8K context
    'gpt-4-turbo': 100_000,  // 128K context
    'gpt-4o': 100_000,  // 128K context
    'gpt-3.5-turbo': 12_000,  // 16K context
    'claude-3-opus': 150_000,  // 200K context
    'claude-3-sonnet': 150_000,
    'claude-3-haiku': 150_000,
    'default': 4_000,  // Conservative fallback
};

/**
 * Approximate token count using the ~4 chars/token heuristic.
 * For Portuguese text, this is conservative (PT tends to have
 * more chars per token than English).
 * 
 * A proper tiktoken/sentencepiece tokenizer can be added later
 * for exact counts — this approach avoids an extra dependency
 * while being safe (slightly overestimates token usage).
 */
export function estimateTokens(text: string): number {
    // Rule: ~4 characters ≈ 1 token (conservative for multilingual)
    return Math.ceil(text.length / 4);
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
        start = end - overlap;

        if (start >= text.length) break;
    }
    return chunks.filter(c => c.length > 0);
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

    const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
        {
            content: { parts: [{ text }] },
        },
        { timeout: 15000 }
    );

    return response.data.embedding.values;
}

// ---------------------------------------------------------------------------
// Document Ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a document: chunk it, generate embeddings, and store in PostgreSQL.
 */
export async function ingestDocument(
    pool: Pool,
    kbId: string,
    content: string,
    metadata?: Record<string, any>
): Promise<{ chunksStored: number }> {
    const chunks = chunkText(content);
    let stored = 0;

    for (const chunk of chunks) {
        try {
            const embedding = await generateEmbedding(chunk);
            const vectorStr = `[${embedding.join(',')}]`;

            await pool.query(
                `INSERT INTO documents (kb_id, content, metadata, embedding) 
                 VALUES ($1, $2, $3, $4::vector)`,
                [kbId, chunk, JSON.stringify(metadata || {}), vectorStr]
            );
            stored++;
        } catch (error) {
            console.error(`Error embedding chunk: ${error}`);
        }
    }

    return { chunksStored: stored };
}

// ---------------------------------------------------------------------------
// Similarity Search (basic)
// ---------------------------------------------------------------------------

/**
 * Search for relevant document chunks using cosine similarity.
 * Returns the top-K most similar chunks to the query.
 */
export async function searchSimilarChunks(
    pool: Pool,
    kbId: string,
    queryText: string,
    topK: number = 3
): Promise<{ content: string; similarity: number }[]> {
    const queryEmbedding = await generateEmbedding(queryText);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const result = await pool.query(
        `SELECT content, 1 - (embedding <=> $1::vector) AS similarity
         FROM documents
         WHERE kb_id = $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [vectorStr, kbId, topK]
    );

    return result.rows;
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
    queryText: string,
    model: string = 'default',
    maxCandidates: number = 10
): Promise<TokenAwareSearchResult> {
    const tokenBudget = getTokenBudget(model);
    const SEPARATOR = '\n---\n';
    const separatorTokens = estimateTokens(SEPARATOR);

    // Fetch a generous pool of candidates
    const candidates = await searchSimilarChunks(pool, kbId, queryText, maxCandidates);

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
