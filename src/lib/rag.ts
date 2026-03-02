import axios from 'axios';
import { Pool } from 'pg';

/**
 * RAG Engine - Retrieval-Augmented Generation
 * 
 * Handles:
 * 1. Text chunking (splitting long documents)
 * 2. Embedding generation via LiteLLM 
 * 3. Vector similarity search in PostgreSQL (pgvector)
 */

const CHUNK_SIZE = 500; // characters per chunk
const CHUNK_OVERLAP = 50;

/**
 * Split a long text into overlapping chunks for better retrieval.
 */
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        chunks.push(text.substring(start, end));
        start += chunkSize - overlap;
    }
    return chunks;
}

/**
 * Generate embeddings for a text using Gemini's Embedding API directly.
 * We bypass LiteLLM for embeddings since its proxy doesn't fully support Gemini embedding routing.
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
            // Continue with remaining chunks
        }
    }

    return { chunksStored: stored };
}

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
