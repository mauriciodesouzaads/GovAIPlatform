/**
 * Shield Worker Tests — Sprint 3
 *
 * T1: generate-findings is a no-op when no organizations exist
 * T2: collect-oauth gracefully skips when MICROSOFT_TOKEN is not set
 * T3: Mailer.sendShieldCriticalAlert does not throw when SMTP is not configured
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runGenerateFindings, runCollectOAuth } from '../workers/shield.worker';
import { Mailer } from '../lib/mailer';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a mock PG client that returns empty rows by default.
 * The query mock is flexible: you can pass a custom handler per SQL fragment.
 */
function createMockClient(overrides?: ((sql: string, params?: unknown[]) => { rows: unknown[] } | null) | undefined) {
    const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        if (overrides) {
            const result = overrides(sql, params);
            if (result !== null) return result;
        }
        return { rows: [] };
    });
    return {
        query,
        release: vi.fn(),
    };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
    return {
        connect: vi.fn().mockResolvedValue(mockClient),
    } as any;
}

// ── T1: generate-findings no-op on empty orgs ──────────────────────────────

describe('T1: runGenerateFindings — no-op when no orgs exist', () => {
    beforeEach(() => vi.clearAllMocks());

    it('completes without error and makes no finding queries when organizations table is empty', async () => {
        // Pool returns empty org list for every query
        const client = createMockClient((sql) => {
            // SET ROLE / RESET ROLE
            if (sql.includes('SET ROLE') || sql.includes('RESET ROLE')) return { rows: [] };
            // organizations query → empty
            if (sql.includes('FROM organizations')) return { rows: [] };
            // Unexpected query — should NOT be reached
            return { rows: [] };
        });
        const pool = createMockPool(client);

        // Should resolve without throwing
        await expect(runGenerateFindings(pool)).resolves.toBeUndefined();

        // The organizations query must have been called
        const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls as string[][];
        const orgQuery = calls.find((args) => typeof args[0] === 'string' && args[0].includes('FROM organizations'));
        expect(orgQuery).toBeDefined();

        // No shield_findings queries should have been made (no orgs to process)
        const findingsQuery = calls.find((args) => typeof args[0] === 'string' && args[0].includes('shield_findings'));
        expect(findingsQuery).toBeUndefined();
    });
});

// ── T2: collect-oauth graceful skip without MICROSOFT_TOKEN ───────────────

describe('T2: runCollectOAuth — graceful skip without MICROSOFT_TOKEN', () => {
    const originalToken = process.env.MICROSOFT_TOKEN;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.MICROSOFT_TOKEN;
    });

    afterEach(() => {
        if (originalToken !== undefined) {
            process.env.MICROSOFT_TOKEN = originalToken;
        } else {
            delete process.env.MICROSOFT_TOKEN;
        }
    });

    it('returns early without querying the database when MICROSOFT_TOKEN is absent', async () => {
        const client = createMockClient(undefined);
        const pool = createMockPool(client);

        await expect(runCollectOAuth(pool)).resolves.toBeUndefined();

        // Pool.connect should never have been called — no DB access at all
        expect(pool.connect).not.toHaveBeenCalled();
    });

    it('does not throw even if the DB pool is unavailable', async () => {
        const brokenPool = {
            connect: vi.fn().mockRejectedValue(new Error('DB unavailable')),
        } as any;

        await expect(runCollectOAuth(brokenPool)).resolves.toBeUndefined();
        expect(brokenPool.connect).not.toHaveBeenCalled();
    });
});

// ── T3: Mailer.sendShieldCriticalAlert does not throw without SMTP ─────────

describe('T3: Mailer.sendShieldCriticalAlert — no-throw without SMTP', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns void without throwing when SMTP env vars are missing', async () => {
        // Instantiate a fresh Mailer with no SMTP env vars
        const savedVars: Record<string, string | undefined> = {};
        const smtpKeys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'DPO_EMAIL'];
        for (const key of smtpKeys) {
            savedVars[key] = process.env[key];
            delete process.env[key];
        }

        try {
            const mailer = new Mailer();
            expect(mailer.isConfigured()).toBe(false);

            // Should not throw
            await expect(
                mailer.sendShieldCriticalAlert({
                    toEmail: 'admin@example.com',
                    orgName: 'Acme Corp',
                    findingCount: 3,
                    criticalTools: [
                        { toolName: 'ChatGPT', riskScore: 85 },
                        { toolName: 'Midjourney', riskScore: 72 },
                    ],
                    postureUrl: 'http://localhost:3001/shield',
                })
            ).resolves.toBeUndefined();
        } finally {
            // Restore env vars
            for (const key of smtpKeys) {
                if (savedVars[key] !== undefined) {
                    process.env[key] = savedVars[key];
                } else {
                    delete process.env[key];
                }
            }
        }
    });

    it('isConfigured() returns false without SMTP_HOST', () => {
        const savedHost = process.env.SMTP_HOST;
        delete process.env.SMTP_HOST;
        try {
            const mailer = new Mailer();
            expect(mailer.isConfigured()).toBe(false);
        } finally {
            if (savedHost !== undefined) process.env.SMTP_HOST = savedHost;
        }
    });
});
