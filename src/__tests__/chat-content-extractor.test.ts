/**
 * FASE 13.5b/2 — extractContent helper unit tests.
 *
 * Catches the "(sem resposta)" regression from 13.5a3 where Anthropic-
 * shaped responses were flattened to the placeholder instead of being
 * rendered. Six shapes covered (happy + three real-world
 * alternatives + two empty forms).
 */

import { describe, it, expect } from 'vitest';
import { extractContent } from '../routes/chat.routes';

describe('extractContent', () => {
    it('returns plain string content verbatim', () => {
        expect(extractContent({ content: 'Hello world' })).toBe('Hello world');
    });

    it('joins Anthropic-style content blocks, keeping only `text` blocks', () => {
        const msg = {
            content: [
                { type: 'text', text: 'first line' },
                { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
                { type: 'text', text: 'second line' },
            ],
        };
        expect(extractContent(msg)).toBe('first line\nsecond line');
    });

    it('describes tool_calls when content is null (tool-only turn)', () => {
        const msg = {
            content: null,
            tool_calls: [
                { function: { name: 'Write' } },
                { function: { name: 'Bash' } },
            ],
        };
        expect(extractContent(msg)).toBe('[aguardando próximo turno: Write, Bash]');
    });

    it('falls back to (sem resposta) when content null AND no tool_calls', () => {
        expect(extractContent({ content: null })).toBe('(sem resposta)');
    });

    it('returns (sem resposta) for undefined msg', () => {
        expect(extractContent(undefined)).toBe('(sem resposta)');
    });

    it('returns (sem resposta) for empty string content', () => {
        expect(extractContent({ content: '' })).toBe('(sem resposta)');
    });
});
