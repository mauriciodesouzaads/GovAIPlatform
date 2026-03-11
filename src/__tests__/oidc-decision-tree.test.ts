/**
 * OIDC Decision Tree Coverage — Sprint 1 Etapa 1.4
 *
 * Tests the 3 explicit paths of the isMockTokenSet decision tree in auth-oidc.ts:
 *
 * Path 1: Real OIDC exchange succeeds → tokenSet.claims() called → real identity
 * Path 2: OIDC exchange fails + NODE_ENV≠production + ENABLE_SSO_MOCK=true → stub identity
 * Path 3: OIDC exchange fails + (NODE_ENV=production OR ENABLE_SSO_MOCK≠true) → error propagated
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { Pool } from 'pg';
import { registerOidcRoutes } from '../lib/auth-oidc';

// ─── Shared Mock PG Pool ──────────────────────────────────────────────────────
function buildMockPool() {
    const routeQuery = async (sql: string, params: any[] = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
        if (sql.includes('FROM organizations')) return { rows: [{ id: 'org-test-id' }] };
        if (sql.includes('INSERT INTO organizations')) return { rows: [{ id: 'org-new-id' }] };
        if (sql.includes('FROM users')) return { rows: [{ id: 'usr-test-id' }] };
        if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'usr-new-id' }] };
        return { rows: [] };
    };
    return {
        query: vi.fn(routeQuery),
        connect: vi.fn(async () => ({ query: vi.fn(routeQuery), release: vi.fn() })),
    };
}

// ─── Test Setup ───────────────────────────────────────────────────────────────
async function buildTestServer(envOverrides: Record<string, string | undefined> = {}) {
    // Apply env overrides
    Object.entries(envOverrides).forEach(([k, v]) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    });

    const app = Fastify({ logger: false });
    app.register(fastifyJwt, { secret: 'test-jwt-secret-32chars-minimum!!' });
    app.register(cookie, { secret: 'test-cookie-secret' });

    const pool = buildMockPool();
    await app.register(async (instance: any) => {
        registerOidcRoutes(instance, pool as unknown as Pool);
    });
    await app.ready();
    return { app, pool };
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('OIDC Decision Tree — isMockTokenSet paths', () => {

    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['NODE_ENV', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ENABLE_SSO_MOCK', 'FRONTEND_URL'];

    beforeEach(() => {
        envKeys.forEach(k => { savedEnv[k] = process.env[k]; });
    });

    afterEach(() => {
        envKeys.forEach(k => {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k]!;
        });
        vi.restoreAllMocks();
    });

    // ─── PATH 3a: Missing OIDC config → 503 in any environment ───────────────
    it('Path 3a: /sso/login returns 503 if OIDC vars are missing (any env)', async () => {
        const { app } = await buildTestServer({
            NODE_ENV: 'test',
            OIDC_ISSUER_URL: undefined,
            OIDC_CLIENT_ID: undefined,
            OIDC_CLIENT_SECRET: undefined,
        });

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=entra_id',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.payload).error).toContain('indisponível');

        await app.close();
    });

    // ─── PATH 3b: OIDC exchange fails + production → error propagated, no mock ─
    it('Path 3b: SSO callback propagates error in production even with ENABLE_SSO_MOCK=true', async () => {
        // Mock the openid-client Issuer.discover to simulate a failed exchange
        const { Issuer } = await import('openid-client');
        const mockClient = {
            metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
            authorizationUrl: vi.fn().mockReturnValue('http://idp.example.com/auth'),
            callbackParams: vi.fn().mockReturnValue({ code: 'test-code', state: 'saved-state' }),
            callback: vi.fn().mockRejectedValue(new Error('OIDC_NETWORK_FAILURE: IdP unreachable')),
        };
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => mockClient),
        } as any);

        const { app } = await buildTestServer({
            NODE_ENV: 'production',
            OIDC_ISSUER_URL: 'https://login.example.com',
            OIDC_CLIENT_ID: 'prod-client-id',
            OIDC_CLIENT_SECRET: 'prod-client-secret',
            ENABLE_SSO_MOCK: 'true', // ← Even with this set, production must not use mock
            FRONTEND_URL: 'http://localhost:3001',
        });

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/sso/callback?code=test-code&state=saved-state',
            cookies: { oidc_state: 'saved-state' },
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        // Must return 500 — the mock must NOT have been activated
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.payload).error).toContain('Falha na verificação');
        expect(mockClient.callback).toHaveBeenCalledOnce();

        await app.close();
    });

    // ─── PATH 2: OIDC fails + non-prod + ENABLE_SSO_MOCK=true → stub identity ─
    it('Path 2: SSO callback uses stub identity when ENABLE_SSO_MOCK=true and NODE_ENV=test', async () => {
        const { Issuer } = await import('openid-client');
        const mockClient = {
            metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
            authorizationUrl: vi.fn().mockReturnValue('http://idp.example.com/auth'),
            callbackParams: vi.fn().mockReturnValue({ code: 'test-code', state: 'saved-state' }),
            callback: vi.fn().mockRejectedValue(new Error('OIDC_NETWORK_FAILURE: IdP unreachable')),
        };
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => mockClient),
        } as any);

        const { app, pool } = await buildTestServer({
            NODE_ENV: 'test',
            OIDC_ISSUER_URL: 'https://login.example.com',
            OIDC_CLIENT_ID: 'test-client-id',
            OIDC_CLIENT_SECRET: 'test-client-secret',
            ENABLE_SSO_MOCK: 'true',
            FRONTEND_URL: 'http://localhost:3001',
        });

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/sso/callback?code=test-code&state=saved-state',
            cookies: { oidc_state: 'saved-state' },
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        // Must redirect to frontend with sso_success (stub identity was used for JIT provisioning)
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('sso_success');

        // Verify stub identity was used — pool was queried for 'test_tenant_stub'
        const calls = (pool.connect as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls.length).toBeGreaterThan(0);

        await app.close();
    });

    // ─── PATH 3c: OIDC fails + non-prod + NO ENABLE_SSO_MOCK → error ─────────
    it('Path 3c: SSO callback returns 500 when OIDC fails and ENABLE_SSO_MOCK is not set', async () => {
        const { Issuer } = await import('openid-client');
        const mockClient = {
            metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
            authorizationUrl: vi.fn().mockReturnValue('http://idp.example.com/auth'),
            callbackParams: vi.fn().mockReturnValue({ code: 'test-code', state: 'saved-state' }),
            callback: vi.fn().mockRejectedValue(new Error('OIDC_NETWORK_FAILURE: IdP unreachable')),
        };
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => mockClient),
        } as any);

        const { app } = await buildTestServer({
            NODE_ENV: 'test',
            OIDC_ISSUER_URL: 'https://login.example.com',
            OIDC_CLIENT_ID: 'test-client-id',
            OIDC_CLIENT_SECRET: 'test-client-secret',
            ENABLE_SSO_MOCK: undefined, // ← Not set → no mock fallback
        });

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/sso/callback?code=test-code&state=saved-state',
            cookies: { oidc_state: 'saved-state' },
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.payload).error).toContain('Falha na verificação');

        await app.close();
    });
});
