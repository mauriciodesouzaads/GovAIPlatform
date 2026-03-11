import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { registerOidcRoutes } from '../lib/auth-oidc';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';

describe('Corporate SSO OIDC Flow (auth-oidc)', () => {
    let fastify: any;
    let mockPgPool: any;

    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['NODE_ENV', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ENABLE_SSO_MOCK', 'FRONTEND_URL'];

    beforeEach(async () => {
        envKeys.forEach(k => { savedEnv[k] = process.env[k]; });

        process.env.OIDC_ISSUER_URL = 'https://login.microsoftonline.com/common/v2.0';
        process.env.OIDC_CLIENT_ID = 'test-id';
        process.env.OIDC_CLIENT_SECRET = 'test-secret';

        fastify = Fastify();
        // Setup minimal fastify environment for the plugin
        fastify.register(fastifyJwt, { secret: 'dummy-secret-12345678901234567890' });
        fastify.register(cookie, { secret: 'dummy-cookie-secret' });

        mockPgPool = {
            query: vi.fn(),
        };

        await fastify.register(async (instance: any) => {
            registerOidcRoutes(instance, mockPgPool);
        });

        await fastify.ready();
    });

    afterEach(async () => {
        envKeys.forEach(k => {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k]!;
        });
        vi.restoreAllMocks();
        await fastify.close();
    });

    it('GET /v1/auth/sso/login should redirect to Identity Provider authorization endpoint', async () => {
        const { Issuer } = await import('openid-client');
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => ({
                metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
                authorizationUrl: vi.fn().mockReturnValue('https://login.microsoftonline.com/auth?response_type=code&client_id=123'),
            })),
        } as any);

        const response = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=entra_id',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        // The plugin generates a URL to microsoftonline or generic IDP and redirects (302)
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toContain('microsoftonline.com');
        expect(response.headers.location).toContain('response_type=code');
        expect(response.headers.location).toContain('client_id=');
        expect(response.headers['set-cookie']).toBeDefined(); // Should set state and nonce cookies
    });

    it('GET /v1/auth/sso/login should enforce allowed providers', async () => {
        const { Issuer } = await import('openid-client');
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => ({
                metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
                authorizationUrl: vi.fn().mockReturnValue('https://login.microsoftonline.com/'),
            })),
        } as any);

        const response = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=unsupported_provider',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.payload)).toHaveProperty('error', 'Provedor SSO não suportado ou em branco.');
    });

});
