/**
 * GovAI Platform — Embedding Configuration
 *
 * Centralizes the vector dimension used by pgvector (documents.embedding)
 * and the embedding model. Must stay in sync with:
 *   - init.sql: documents.embedding vector(768)
 *   - rag.ts: generateEmbedding outputDimensionality
 *
 * If EMBEDDING_MODEL changes, verify the new model's output dimension
 * and update EMBEDDING_DIMENSION + migration 032 if needed.
 */
export const EMBEDDING_DIMENSION = 768;

export const EMBEDDING_MODEL =
    process.env.EMBEDDING_MODEL || 'sentence-transformers/all-mpnet-base-v2';
