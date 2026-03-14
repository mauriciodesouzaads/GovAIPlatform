/**
 * P-11: API Key Rotation Job Tests
 *
 * Verifies TTL enforcement: expire, warn, and default 90-day TTL.
 * Mocks pgPool and logger — no real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runApiKeyRotationCycle } from '../jobs/api-key-rotation.job';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function createMockClient(handlers: {
    expired?: () => { rows: unknown[] };
    expiringSoon?: () => { rows: unknown[] };
    ttlApplied?: () => { rows: unknown[] };
}) {
    const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('SET ROLE') || sql.includes('RESET ROLE')) return { rows: [] };
        if (sql.includes('expires_at < NOW()') && sql.includes('expired_ttl')) {
            return handlers.expired ? handlers.expired() : { rows: [] };
        }
        if (sql.includes('expires_at BETWEEN NOW()')) {
            return handlers.expiringSoon ? handlers.expiringSoon() : { rows: [] };
        }
        if (sql.includes('expires_at IS NULL') && sql.includes('created_at +')) {
            return handlers.ttlApplied ? handlers.ttlApplied() : { rows: [] };
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('P-11: API Key Rotation Job', () => {
    beforeEach(() => vi.clearAllMocks());

    it('Caso 1: chave com expires_at ontem → is_active=false após job', async () => {
        const mockClient = createMockClient({
            expired: () => ({
                rows: [{ id: 'k1', org_id: 'o1', name: 'Key1', prefix: 'sk-govai-xxx' }],
            }),
        });
        const pool = createMockPool(mockClient);

        await runApiKeyRotationCycle(pool);

        const updateCalls = (mockClient.query.mock.calls as [string, ...unknown[]][]).filter(
            (c) => c[0].includes('expired_ttl') && c[0].includes('expires_at < NOW()')
        );
        expect(updateCalls.length).toBeGreaterThanOrEqual(1);
        expect(updateCalls[0][0]).toContain("revoke_reason = 'expired_ttl'");
        expect(updateCalls[0][0]).toMatch(/is_active\s*=\s*false/);
    });

    it('Caso 2: chave com expires_at daqui a 30 dias → permanece ativa', async () => {
        const mockClient = createMockClient({
            expired: () => ({ rows: [] }),
        });
        const pool = createMockPool(mockClient);

        await runApiKeyRotationCycle(pool);

        const updateCall = (mockClient.query.mock.calls as [string, ...unknown[]][]).find(
            (c) => c[0].includes('expired_ttl')
        );
        expect(updateCall).toBeDefined();
        expect(updateCall![0]).toContain('expires_at < NOW()');
        // No rows returned = no keys expired = keys with future expires_at stay active
    });

    it('Caso 3: chave com expires_at daqui a 7 dias → logger.warn chamado', async () => {
        const mockClient = createMockClient({
            expiringSoon: () => ({
                rows: [{
                    id: 'k2',
                    org_id: 'o1',
                    name: 'Key2',
                    prefix: 'sk-govai-yyy',
                    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                }],
            }),
        });
        const pool = createMockPool(mockClient);
        const logger = { warn: vi.fn() };

        await runApiKeyRotationCycle(pool, logger);

        expect(logger.warn).toHaveBeenCalledWith(
            '[ApiKeyRotation] Key expiring soon',
            expect.objectContaining({ id: 'k2', prefix: 'sk-govai-yyy' })
        );
    });

    it('Caso 4: chave sem expires_at → recebe created_at + 90 dias', async () => {
        const mockClient = createMockClient({
            ttlApplied: () => ({
                rows: [{ id: 'k3', prefix: 'sk-govai-zzz' }],
            }),
        });
        const pool = createMockPool(mockClient);
        const logger = { warn: vi.fn() };

        await runApiKeyRotationCycle(pool, logger);

        const ttlCall = (mockClient.query.mock.calls as [string, ...unknown[]][]).find(
            (c) => c[0].includes('expires_at IS NULL') && c[0].includes('created_at +')
        );
        expect(ttlCall).toBeDefined();
        expect(ttlCall![0]).toContain("' days')::INTERVAL");
        expect(ttlCall![1]).toEqual([90]);
        expect(logger.warn).toHaveBeenCalledWith(
            '[ApiKeyRotation] Applied default TTL (90 days) to keys without expiration',
            expect.any(Object)
        );
    });

    it('Caso 5: chave já inativa (is_active=false) → não é alterada', async () => {
        const mockClient = createMockClient({
            expired: () => ({ rows: [] }),
        });
        const pool = createMockPool(mockClient);

        await runApiKeyRotationCycle(pool);

        const updateCall = (mockClient.query.mock.calls as [string, ...unknown[]][]).find(
            (c) => c[0].includes('expired_ttl')
        );
        expect(updateCall![0]).toContain('is_active = true');
        // Keys with is_active=false are excluded by WHERE — mock returns [] as if none matched
    });

    it('Caso 6: chave com revoke_reason já preenchido → não é sobrescrito', async () => {
        const mockClient = createMockClient({
            expired: () => ({ rows: [] }),
        });
        const pool = createMockPool(mockClient);

        await runApiKeyRotationCycle(pool);

        const updateCall = (mockClient.query.mock.calls as [string, ...unknown[]][]).find(
            (c) => c[0].includes('expired_ttl')
        );
        expect(updateCall![0]).toContain('revoke_reason IS NULL');
        // Keys with revoke_reason set are excluded by WHERE — never overwritten
    });
});
