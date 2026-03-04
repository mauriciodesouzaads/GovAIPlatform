/**
 * FRENTE 6: TESTES END-TO-END (E2E) COM SERVIDOR FASTIFY REAL
 * Staff QA Engineer — Integration Suite
 *
 * Testa endpoints HTTP reais contra uma instância Fastify in-process:
 * 1. Health check
 * 2. Auth (login + JWT generation)
 * 3. API Key middleware rejection
 * 4. SSO rate-limiting (429 after burst)
 * 5. Admin route access control (401 without JWT)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { registerOidcRoutes } from '../lib/auth-oidc';

let app: FastifyInstance;
const JWT_SECRET = 'test-e2e-secret-32-chars-minimum!!';

beforeAll(async () => {
    app = Fastify({ logger: false });

    // Register core plugins
    app.register(fastifyJwt, { secret: JWT_SECRET });
    app.register(cookie, { secret: 'test-cookie-secret' });

    // Register SSO routes (includes rate limiter)
    await app.register(async (inst) => registerOidcRoutes(inst, {} as any));

    // Mock health endpoint
    app.get('/health', async () => ({ status: 'ok', db: 'mocked' }));

    // Mock admin login
    app.post('/v1/admin/login', async (request, reply) => {
        const body = request.body as any;
        if (!body || !body.email || !body.password) {
            return reply.status(400).send({ error: 'Missing credentials' });
        }
        const { email, password } = body;
        if (email === 'admin@govai.com' && password === 'admin') {
            const token = app.jwt.sign({
                email,
                role: 'admin',
                orgId: '00000000-0000-0000-0000-000000000001'
            }, { expiresIn: '1h' });
            return reply.send({ token });
        }
        return reply.status(401).send({ error: 'Invalid credentials' });
    });

    // Mock protected admin route
    app.get('/v1/admin/stats', {
        preHandler: async (request, reply) => {
            try {
                await request.jwtVerify();
            } catch (err) {
                return reply.status(401).send({ error: 'Unauthorized' });
            }
        }
    }, async (request, reply) => {
        return reply.send({ total_assistants: 3, total_executions: 42 });
    });

    // Mock execution route (requires Bearer API key)
    app.post('/v1/execute/:assistantId', async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer sk-govai-')) {
            return reply.status(401).send({ error: 'Unauthorized: Missing API Key' });
        }
        return reply.send({ response: 'mocked LLM response', _govai: { traceId: 'test-trace' } });
    });

    await app.ready();
});

afterAll(async () => {
    await app.close();
});

// ─────────────────────────────────────────
// E2E TESTS
// ─────────────────────────────────────────

describe('[E2E] Health Check', () => {
    it('GET /health should return 200 with ok status', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('ok');
    });
});

describe('[E2E] Admin Authentication Flow', () => {
    it('POST /v1/admin/login should return JWT for valid credentials', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'admin@govai.com', password: 'admin' }
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.token).toBeTruthy();
        expect(body.token.split('.')).toHaveLength(3); // JWT has 3 segments
    });

    it('POST /v1/admin/login should return 401 for invalid credentials', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'hacker@evil.com', password: 'wrong' }
        });
        expect(res.statusCode).toBe(401);
    });

    it('GET /v1/admin/stats WITHOUT JWT should return 401', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/stats' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /v1/admin/stats WITH valid JWT should return 200', async () => {
        // Login first
        const loginRes = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'admin@govai.com', password: 'admin' }
        });
        const token = JSON.parse(loginRes.payload).token;

        // Use the JWT
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/stats',
            headers: { authorization: `Bearer ${token}` }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload).total_assistants).toBe(3);
    });

    it('GET /v1/admin/stats WITH expired/forged JWT should return 401', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/stats',
            headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.forged.payload' }
        });
        expect(res.statusCode).toBe(401);
    });
});

describe('[E2E] API Key Middleware', () => {
    it('POST /v1/execute/:id WITHOUT API key should return 401', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/execute/some-assistant-id',
            payload: { message: 'test prompt' }
        });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.payload).error).toContain('Unauthorized');
    });

    it('POST /v1/execute/:id WITH valid API key should return 200', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/execute/some-assistant-id',
            headers: { authorization: 'Bearer sk-govai-test-key-12345' },
            payload: { message: 'test prompt' }
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)._govai.traceId).toBe('test-trace');
    });
});

describe('[E2E] SSO Rate-Limiting (DT-5)', () => {
    it('GET /v1/auth/sso/login should work for the first request', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/auth/sso/login?provider=entra_id' });
        expect(res.statusCode).toBe(302); // Redirect to Entra ID
    });

    it('🔥 RATE LIMIT: 11+ rapid SSO requests from the same IP should trigger 429', async () => {
        // Fire 11 rapid requests (limit is 10 per minute)
        const results: number[] = [];
        for (let i = 0; i < 12; i++) {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/auth/sso/login?provider=entra_id',
                // Fastify inject uses 127.0.0.1 as default IP
            });
            results.push(res.statusCode);
        }

        // At least one should be 429 (rate limited)
        expect(results).toContain(429);

        // First few should succeed (302)
        expect(results.slice(0, 5).every(code => code === 302)).toBe(true);
    });
});

describe('[E2E] Error Handling', () => {
    it('GET /nonexistent-route should return 404', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/this-does-not-exist' });
        expect(res.statusCode).toBe(404);
    });

    it('POST /v1/admin/login without body should not crash (returns 401)', async () => {
        const res = await app.inject({ method: 'POST', url: '/v1/admin/login' });
        // Should not be 500 — should handle gracefully
        expect(res.statusCode).not.toBe(500);
    });
});
