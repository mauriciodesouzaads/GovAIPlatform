import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerOidcRoutes } from '../lib/auth-oidc';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';

describe('Corporate SSO OIDC Flow (auth-oidc)', () => {
    let fastify: any;
    let mockPgPool: any;

    beforeEach(async () => {
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

    it('GET /v1/auth/sso/login should redirect to Identity Provider authorization endpoint', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=entra_id'
        });

        // The plugin generates a URL to microsoftonline or generic IDP and redirects (302)
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toContain('microsoftonline.com');
        expect(response.headers.location).toContain('response_type=code');
        expect(response.headers.location).toContain('client_id=');
        expect(response.headers['set-cookie']).toBeDefined(); // Should set state and nonce cookies
    });

    it('GET /v1/auth/sso/login should enforce allowed providers', async () => {
        const response = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=unsupported_provider'
        });

        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.payload)).toHaveProperty('error', 'Provedor SSO não suportado ou em branco.');
    });

});
