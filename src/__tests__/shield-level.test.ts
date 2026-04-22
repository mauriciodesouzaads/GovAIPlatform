/**
 * Unit tests — src/lib/shield-level.ts
 * ---------------------------------------------------------------------------
 * Covers the decision matrix (requiresApproval) and the resolver behavior
 * against an in-memory Pool shim. The DB trigger that enforces
 * "assistant.shield_level >= org.shield_level" is exercised by the
 * integration test; here we only verify the library surface.
 */

import { describe, it, expect } from 'vitest';
import {
    isShieldLevel,
    requiresApproval,
    requiresHitlForTool,
    resolveShieldLevel,
} from '../lib/shield-level';

type Rows = Array<Record<string, unknown>>;

function makePoolShim(rowsByPattern: Array<{ match: RegExp; rows: Rows }>): any {
    const runQuery = async (sql: string, _params?: any[]) => {
        for (const entry of rowsByPattern) {
            if (entry.match.test(sql)) {
                return { rows: entry.rows, rowCount: entry.rows.length };
            }
        }
        return { rows: [], rowCount: 0 };
    };
    return {
        connect: async () => ({
            query: runQuery,
            release: () => { /* noop */ },
        }),
    };
}

describe('isShieldLevel', () => {
    it('accepts 1, 2, 3', () => {
        expect(isShieldLevel(1)).toBe(true);
        expect(isShieldLevel(2)).toBe(true);
        expect(isShieldLevel(3)).toBe(true);
    });
    it('rejects 0, 4, null, strings, undefined', () => {
        expect(isShieldLevel(0)).toBe(false);
        expect(isShieldLevel(4)).toBe(false);
        expect(isShieldLevel(null)).toBe(false);
        expect(isShieldLevel('2')).toBe(false);
        expect(isShieldLevel(undefined)).toBe(false);
    });
});

describe('requiresApproval matrix', () => {
    it('level 1 never requires approval', () => {
        expect(requiresApproval('tool_use_destructive', 1)).toBe(false);
        expect(requiresApproval('policy_publish', 1)).toBe(false);
        expect(requiresApproval('risk_assessment', 1)).toBe(false);
        expect(requiresApproval('security_exception', 1)).toBe(false);
        expect(requiresApproval('exception_approval', 1)).toBe(false);
    });

    it('level 2 requires approval for formal actions but NOT for tool use', () => {
        expect(requiresApproval('policy_publish', 2)).toBe(true);
        expect(requiresApproval('risk_assessment', 2)).toBe(true);
        expect(requiresApproval('security_exception', 2)).toBe(true);
        expect(requiresApproval('exception_approval', 2)).toBe(true);
        expect(requiresApproval('tool_use_destructive', 2)).toBe(false);
    });

    it('level 3 requires approval for every governed action', () => {
        expect(requiresApproval('tool_use_destructive', 3)).toBe(true);
        expect(requiresApproval('policy_publish', 3)).toBe(true);
        expect(requiresApproval('risk_assessment', 3)).toBe(true);
        expect(requiresApproval('security_exception', 3)).toBe(true);
        expect(requiresApproval('exception_approval', 3)).toBe(true);
    });

    it('requiresHitlForTool matches level-gated tool_use_destructive', () => {
        expect(requiresHitlForTool(1)).toBe(false);
        expect(requiresHitlForTool(2)).toBe(false);
        expect(requiresHitlForTool(3)).toBe(true);
    });
});

describe('resolveShieldLevel', () => {
    const ORG = '00000000-0000-0000-0000-000000000001';

    it('returns org.shield_level when no assistantId', async () => {
        const pool = makePoolShim([
            { match: /FROM organizations/, rows: [{ shield_level: 2 }] },
        ]);
        expect(await resolveShieldLevel(pool, ORG)).toBe(2);
    });

    it('prefers assistant.shield_level when set', async () => {
        const pool = makePoolShim([
            { match: /FROM assistants a/, rows: [{ level: 3 }] },
            { match: /FROM organizations/, rows: [{ shield_level: 1 }] },
        ]);
        expect(await resolveShieldLevel(pool, ORG, 'asst-1')).toBe(3);
    });

    it('falls back to org when assistant row missing', async () => {
        const pool = makePoolShim([
            { match: /FROM assistants a/, rows: [] },
            { match: /FROM organizations/, rows: [{ shield_level: 2 }] },
        ]);
        expect(await resolveShieldLevel(pool, ORG, 'asst-missing')).toBe(2);
    });

    it('fails open to level 1 on missing/corrupt data', async () => {
        const pool = makePoolShim([
            { match: /FROM organizations/, rows: [{ shield_level: 99 }] }, // invalid
        ]);
        expect(await resolveShieldLevel(pool, ORG)).toBe(1);
    });

    it('fails open to level 1 when query throws', async () => {
        const pool: any = {
            connect: async () => ({
                query: async () => { throw new Error('DB down'); },
                release: () => { /* noop */ },
            }),
        };
        expect(await resolveShieldLevel(pool, ORG)).toBe(1);
    });
});
