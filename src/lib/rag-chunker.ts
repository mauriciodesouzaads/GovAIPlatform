/**
 * Token-based chunker for the new RAG pipeline — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * Splits a long text into overlapping chunks sized in tokens (not chars)
 * so every chunk fits comfortably in the embedding model's context.
 *
 * Why token-based and not char-based: character chunks of "the same
 * size" can have wildly different token counts depending on language
 * (Portuguese averages 1.4 chars/token, Chinese can be 2+). Token-based
 * gives predictable embedding latency and predictable index cost.
 *
 * Implementation note: gpt-tokenizer is already a dep (used by
 * src/lib/rag.ts for the legacy budget calculation). We reuse it
 * instead of pulling tiktoken (which would be a second WASM blob and
 * an extra install). The tokenizer is GPT-4 cl100k_base, which slightly
 * over-counts for Gemini/Claude — that's the safe direction (chunks
 * stay under the limit).
 *
 * The legacy chunker (src/lib/rag.ts:chunkText) is character-based
 * with sentence-boundary preference. We keep both because the legacy
 * pipeline (pgvector + Gemini) still uses its chunker and changing it
 * would invalidate every embedding in the demo data.
 */

import { encode, decode } from 'gpt-tokenizer';

export interface RagChunk {
    index: number;
    content: string;
    token_count: number;
}

export interface ChunkOptions {
    chunkSizeTokens: number;
    chunkOverlapTokens: number;
}

export function chunkByTokens(text: string, opts: ChunkOptions): RagChunk[] {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];

    const tokens = encode(trimmed);
    if (tokens.length === 0) return [];

    // Validate parameters defensively — a misconfigured KB with overlap
    // ≥ size would loop forever otherwise.
    const size = Math.max(1, opts.chunkSizeTokens | 0);
    const overlap = Math.max(0, Math.min(size - 1, opts.chunkOverlapTokens | 0));
    const stride = size - overlap;

    const chunks: RagChunk[] = [];
    let i = 0;
    let chunkIndex = 0;
    while (i < tokens.length) {
        const end = Math.min(i + size, tokens.length);
        const slice = tokens.slice(i, end);
        const content = decode(slice);
        chunks.push({
            index: chunkIndex,
            content,
            token_count: slice.length,
        });
        chunkIndex++;
        if (end >= tokens.length) break;
        i += stride;
    }
    return chunks;
}
