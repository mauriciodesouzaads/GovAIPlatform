/**
 * P-10: RAG Embedding Dimension Validation
 *
 * Verifies that embedding vectors are validated against EMBEDDING_DIMENSION
 * before INSERT or vector search. Prevents silent pgvector dimension mismatch.
 */
import { describe, it, expect } from 'vitest';
import { validateEmbeddingDimension } from '../lib/rag';
import { EMBEDDING_DIMENSION } from '../lib/embedding-config';

describe('P-10: Embedding Dimension Validation', () => {
    it('Caso 1: embedding com 768 dimensões → não lança erro', () => {
        const embedding = new Array(768).fill(0.1);
        expect(() => validateEmbeddingDimension(embedding)).not.toThrow();
    });

    it('Caso 2: embedding com 1536 dimensões → lança Error com mensagem "Embedding dimension mismatch"', () => {
        const embedding = new Array(1536).fill(0.1);
        expect(() => validateEmbeddingDimension(embedding)).toThrow('Embedding dimension mismatch');
        expect(() => validateEmbeddingDimension(embedding)).toThrow(/expected 768.*got 1536/);
    });

    it('Caso 3: embedding vazio (length 0) → lança Error', () => {
        const embedding: number[] = [];
        expect(() => validateEmbeddingDimension(embedding)).toThrow();
        expect(() => validateEmbeddingDimension(embedding)).toThrow(/got 0/);
    });

    it('Caso 4: EMBEDDING_DIMENSION exportado de embedding-config.ts é um número positivo maior que 0', () => {
        expect(typeof EMBEDDING_DIMENSION).toBe('number');
        expect(EMBEDDING_DIMENSION).toBeGreaterThan(0);
        expect(EMBEDDING_DIMENSION).toBe(768);
    });
});
