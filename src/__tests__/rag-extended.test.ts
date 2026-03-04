import { describe, it, expect } from 'vitest';
import { estimateTokens, getTokenBudget, chunkText } from '../lib/rag';

describe('RAG Engine — Token Estimation', () => {

    describe('estimateTokens', () => {
        it('should return a positive number for non-empty text', () => {
            const tokens = estimateTokens('Hello, world! This is a test sentence.');
            expect(tokens).toBeGreaterThan(0);
        });

        it('should return 0 for an empty string', () => {
            expect(estimateTokens('')).toBe(0);
        });

        it('should return more tokens for longer text', () => {
            const short = estimateTokens('Hello');
            const long = estimateTokens('Hello world, this is a significantly longer piece of text with many more tokens');
            expect(long).toBeGreaterThan(short);
        });

        it('should handle special characters and unicode', () => {
            const tokens = estimateTokens('Olá, meu número é 42! ¿Cómo estás? 日本語テスト');
            expect(tokens).toBeGreaterThan(0);
        });
    });

    describe('getTokenBudget', () => {
        it('should return 6000 for gpt-4', () => {
            expect(getTokenBudget('gpt-4')).toBe(6_000);
        });

        it('should return 800000 for gemini/gemini-2.0-flash', () => {
            expect(getTokenBudget('gemini/gemini-2.0-flash')).toBe(800_000);
        });

        it('should return 150000 for claude-3-opus', () => {
            expect(getTokenBudget('claude-3-opus')).toBe(150_000);
        });

        it('should return the default budget (4000) for an unknown model', () => {
            expect(getTokenBudget('unknown-model-xyz')).toBe(4_000);
        });

        it('should return the default budget when using the "default" key', () => {
            expect(getTokenBudget('default')).toBe(4_000);
        });
    });
});

describe('RAG Engine — Extended Chunking', () => {

    it('should prefer to break at sentence boundaries', () => {
        const text = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth sentence here.';
        const chunks = chunkText(text, 60, 10);
        // Chunks should end at periods when possible
        expect(chunks.length).toBeGreaterThan(1);
        // At least the first chunk should end at a period
        expect(chunks[0]).toMatch(/\.$/);
    });

    it('should return empty array for empty text', () => {
        const chunks = chunkText('', 50, 10);
        expect(chunks).toHaveLength(0);
    });

    it('should handle text exactly equal to chunkSize (overlap produces tail chunk)', () => {
        const text = 'x'.repeat(50);
        const chunks = chunkText(text, 50, 10);
        // With overlap=10, the first chunk covers chars 0-49, then the next
        // start = 50-10=40, producing a small tail chunk. This is expected.
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0]).toBe(text);
    });

    it('should not produce infinite loops with pathological inputs', () => {
        // Edge case: overlap >= chunkSize should still terminate
        const text = 'a'.repeat(200);
        const chunks = chunkText(text, 10, 10);
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.length).toBeLessThan(200); // Sanity check
    });
});
