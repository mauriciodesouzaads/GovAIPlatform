/**
 * S12: OIDC Routes Tests — /v1/auth/oidc/microsoft + /v1/auth/oidc/okta
 *
 * Tests the dedicated provider-specific OIDC routes introduced in Sprint 12.
 * All tests use inject() for zero-network overhead — no real IdP connection.
 *
 * T1: GET /v1/auth/oidc/microsoft without vars → 501
 * T2: GET /v1/auth/oidc/okta without vars → 501
 * T3: GET /v1/auth/oidc/microsoft/callback without code (vars set) → 400
 * T4: GET /v1/auth/oidc/okta/callback without code (vars set) → 400
 * T5: isMicrosoftConfigured / isOktaConfigured guard logic
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';

import oidcRoutes, { isMicrosoftConfigured, isOktaConfigured } from '../routes/oidc.routes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-oidc-jwt-secret-32chars-long!!';

async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    const mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await app.register(oidcRoutes, { pgPool: mockPool });
    await app.ready();
    return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('S12: OIDC Routes', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        // Ensure no OIDC env vars leak from the shell into these tests
        delete process.env.AZURE_CLIENT_ID;
        delete process.env.AZURE_CLIENT_SECRET;
        delete process.env.AZURE_TENANT_ID;
        delete process.env.OKTA_CLIENT_ID;
        delete process.env.OKTA_CLIENT_SECRET;
        delete process.env.OKTA_DOMAIN;

        app = await buildApp();
    });

    afterAll(async () => {
        await app.close();
    });

    // ── T1 ──────────────────────────────────────────────────────────────────
    it('T1: GET /v1/auth/oidc/microsoft returns 501 when AZURE vars are missing', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/microsoft',
        });

        expect(res.statusCode).toBe(501);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('OIDC not configured');
        expect(body.provider).toBe('microsoft');
    });

    // ── T2 ──────────────────────────────────────────────────────────────────
    it('T2: GET /v1/auth/oidc/okta returns 501 when OKTA vars are missing', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/okta',
        });

        expect(res.statusCode).toBe(501);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('OIDC not configured');
        expect(body.provider).toBe('okta');
    });

    // ── T3 ──────────────────────────────────────────────────────────────────
    it('T3: GET /v1/auth/oidc/microsoft/callback without code returns 400', async () => {
        // Set vars so the route passes the 501 guard and reaches the code check
        process.env.AZURE_CLIENT_ID = 'test-client-id';
        process.env.AZURE_CLIENT_SECRET = 'test-client-secret';
        process.env.AZURE_TENANT_ID = 'test-tenant-id';

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/microsoft/callback',
            // No ?code= param — no ?state= either
        });

        delete process.env.AZURE_CLIENT_ID;
        delete process.env.AZURE_CLIENT_SECRET;
        delete process.env.AZURE_TENANT_ID;

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/code|state/i);
    });

    // ── T4 ──────────────────────────────────────────────────────────────────
    it('T4: GET /v1/auth/oidc/okta/callback without code returns 400', async () => {
        process.env.OKTA_CLIENT_ID = 'test-okta-client';
        process.env.OKTA_CLIENT_SECRET = 'test-okta-secret';
        process.env.OKTA_DOMAIN = 'https://dev-example.okta.com/oauth2/default';

        const res = await app.inject({
            method: 'GET',
            url: '/v1/auth/oidc/okta/callback',
        });

        delete process.env.OKTA_CLIENT_ID;
        delete process.env.OKTA_CLIENT_SECRET;
        delete process.env.OKTA_DOMAIN;

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/code|state/i);
    });

    // ── T5 ──────────────────────────────────────────────────────────────────
    it('T5: isMicrosoftConfigured and isOktaConfigured reflect env var presence', () => {
        // No vars → both false
        delete process.env.AZURE_CLIENT_ID;
        delete process.env.AZURE_CLIENT_SECRET;
        delete process.env.AZURE_TENANT_ID;
        delete process.env.OKTA_CLIENT_ID;
        delete process.env.OKTA_CLIENT_SECRET;
        delete process.env.OKTA_DOMAIN;

        expect(isMicrosoftConfigured()).toBe(false);
        expect(isOktaConfigured()).toBe(false);

        // Set Microsoft vars only
        process.env.AZURE_CLIENT_ID = 'id';
        process.env.AZURE_CLIENT_SECRET = 'secret';
        process.env.AZURE_TENANT_ID = 'tenant';

        expect(isMicrosoftConfigured()).toBe(true);
        expect(isOktaConfigured()).toBe(false);

        // Add Okta vars
        process.env.OKTA_CLIENT_ID = 'okta-id';
        process.env.OKTA_CLIENT_SECRET = 'okta-secret';
        process.env.OKTA_DOMAIN = 'https://dev.okta.com';

        expect(isMicrosoftConfigured()).toBe(true);
        expect(isOktaConfigured()).toBe(true);

        // Cleanup
        delete process.env.AZURE_CLIENT_ID;
        delete process.env.AZURE_CLIENT_SECRET;
        delete process.env.AZURE_TENANT_ID;
        delete process.env.OKTA_CLIENT_ID;
        delete process.env.OKTA_CLIENT_SECRET;
        delete process.env.OKTA_DOMAIN;
    });
});
