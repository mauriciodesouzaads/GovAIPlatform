import { describe, it, expect } from 'vitest';
import { chunkText } from '../lib/rag';

describe('RAG Engine', () => {
    it('should split text into chunks based on chunkSize and overlap', () => {
        const text = 'This is a long text that needs to be chunked for vector search. It contains multiple sentences.';
        const chunks = chunkText(text, 50, 10);

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks[0].length).toBeLessThanOrEqual(50);

        // Verify overlap (last 10 chars of chunk 1 should match first 10 chars of chunk 2)
        const overlapText = chunks[0].substring(chunks[0].length - 10);
        expect(chunks[1].substring(0, 10)).toBe(overlapText);
    });

    it('should not split text smaller than chunkSize', () => {
        const text = 'Short text';
        const chunks = chunkText(text, 50, 10);

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe('Short text');
    });
});
