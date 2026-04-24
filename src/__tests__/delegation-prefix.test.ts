/**
 * FASE 13.5b.1 — runtimeFromPrefix unit tests.
 *
 * The prefix-to-runtime map is the part of the delegation decision that
 * answers "which runtime does this message target?". shouldDelegate()
 * answers the separate "should we delegate at all?" question. These
 * tests lock down the mapping and the interaction between the two,
 * because a regression here means "[AIDER] foo" silently routes to
 * the wrong container — the exact user-facing bug this phase closed.
 *
 * Pure-function tests — no DB, no network, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { runtimeFromPrefix, shouldDelegate } from '../lib/runtime-delegation';

describe('runtimeFromPrefix', () => {
    describe('happy path', () => {
        it('maps [AIDER] to aider', () => {
            expect(runtimeFromPrefix('[AIDER] fix the tests')).toBe('aider');
        });

        it('maps [CLAUDE_CODE] to claude_code_official', () => {
            expect(runtimeFromPrefix('[CLAUDE_CODE] refactor this module'))
                .toBe('claude_code_official');
        });

        it('maps [OPENCLAUDE] to openclaude', () => {
            expect(runtimeFromPrefix('[OPENCLAUDE] analise o repo'))
                .toBe('openclaude');
        });
    });

    describe('robustness', () => {
        it('is case-insensitive on the token', () => {
            expect(runtimeFromPrefix('[aider] foo')).toBe('aider');
            expect(runtimeFromPrefix('[Aider] foo')).toBe('aider');
            expect(runtimeFromPrefix('[aIder] foo')).toBe('aider');
        });

        it('tolerates leading whitespace', () => {
            expect(runtimeFromPrefix('   [AIDER] foo')).toBe('aider');
            expect(runtimeFromPrefix('\n[AIDER] foo')).toBe('aider');
            expect(runtimeFromPrefix('\t[AIDER] foo')).toBe('aider');
        });

        it('ignores tokens that are not at the start', () => {
            // Mid-message mentions must NOT reroute — the user talking
            // about "[AIDER]" in a prose context is not a routing signal.
            expect(runtimeFromPrefix('explain how [AIDER] works')).toBeNull();
            expect(runtimeFromPrefix('use [OPENCLAUDE] and [AIDER] together')).toBeNull();
        });

        it('rejects unknown tokens', () => {
            expect(runtimeFromPrefix('[CURSOR] ...')).toBeNull();
            expect(runtimeFromPrefix('[CODEX] ...')).toBeNull();
            expect(runtimeFromPrefix('[] ...')).toBeNull();
        });
    });

    describe('edge cases', () => {
        it('handles empty or null input', () => {
            expect(runtimeFromPrefix('')).toBeNull();
            expect(runtimeFromPrefix(null)).toBeNull();
            expect(runtimeFromPrefix(undefined)).toBeNull();
        });

        it('handles prefix-only messages', () => {
            // Message IS the token — regex still matches; the message
            // body being empty is a separate concern (shouldDelegate
            // will still run on the full message and either match or
            // not). We just need the runtime signal.
            expect(runtimeFromPrefix('[AIDER]')).toBe('aider');
        });
    });
});

describe('shouldDelegate + runtimeFromPrefix composition', () => {
    // The real-world flow: the chat wrapper inspects the message for
    // a prefix (runtimeFromPrefix), and the execution pipeline decides
    // whether to delegate via shouldDelegate. For the Aider UX bug,
    // the two had to agree: the prefix has to be IN the pattern list
    // so shouldDelegate returns true and the prefix-derived runtime
    // gets used. This test documents that invariant.
    const configWithAllPrefixes = {
        enabled: true,
        auto_delegate_patterns: [
            '\\[OPENCLAUDE\\]',
            '\\[CLAUDE_CODE\\]',
            '\\[AIDER\\]',
        ],
        max_duration_seconds: 300,
    };

    it('[AIDER]-prefixed message delegates AND maps to aider', () => {
        const msg = '[AIDER] fix the failing test';
        expect(shouldDelegate(msg, configWithAllPrefixes).shouldDelegate).toBe(true);
        expect(runtimeFromPrefix(msg)).toBe('aider');
    });

    it('[CLAUDE_CODE]-prefixed message delegates AND maps to claude_code_official', () => {
        const msg = '[CLAUDE_CODE] build a feature';
        expect(shouldDelegate(msg, configWithAllPrefixes).shouldDelegate).toBe(true);
        expect(runtimeFromPrefix(msg)).toBe('claude_code_official');
    });

    it('non-prefixed message does not self-route', () => {
        const msg = 'hello there, normal question';
        expect(runtimeFromPrefix(msg)).toBeNull();
        // shouldDelegate also returns false because no pattern matches —
        // the two decisions agree and the message stays in the plain
        // LLM lane.
        expect(shouldDelegate(msg, configWithAllPrefixes).shouldDelegate).toBe(false);
    });

    it('prefix without the corresponding pattern does not delegate', () => {
        // This is the pre-hotfix state: [AIDER] prefix arrives but the
        // pattern array only has [OPENCLAUDE]. The runtime mapping
        // would say "aider", but shouldDelegate says "no" — the
        // message falls through to the normal LLM path. Migration 087
        // is what prevents this in production; here we document why
        // the migration is load-bearing.
        const configWithoutAider = {
            enabled: true,
            auto_delegate_patterns: ['\\[OPENCLAUDE\\]'],
            max_duration_seconds: 300,
        };
        const msg = '[AIDER] do something';
        expect(runtimeFromPrefix(msg)).toBe('aider');
        expect(shouldDelegate(msg, configWithoutAider).shouldDelegate).toBe(false);
    });
});
