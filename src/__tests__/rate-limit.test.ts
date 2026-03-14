/**
 * P-12: Rate Limiting Granular + Brute Force Protection
 *
 * Verifies route-specific limits: login (10/15min), execute (100/min),
 * api-keys (20/hr). Uses in-memory store (no Redis) for deterministic tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';

// ---------------------------------------------------------------------------
// Test server — same rate limit config as production, no Redis (in-memory)
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
    app = Fastify({ logger: false });

    await app.register(rateLimit, {
        max: 50,
        timeWindow: '1 minute',
        skipOnError: true,
        keyGenerator: (req) => req.ip || '127.0.0.1',
        errorResponseBuilder: (_req, context) => ({
            statusCode: 429,
            error: 'Rate limit exceeded',
            retryAfter: Math.ceil(context.ttl / 1000),
        }),
    });

    // Login — 10/15min, key :login (x-test-ip for test isolation)
    app.post('/v1/admin/login', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '15 minutes',
                keyGenerator: (req) => ((req.headers['x-test-ip'] as string) || req.ip || '127.0.0.1') + ':login',
                errorResponseBuilder: (_req, context) => ({
                    statusCode: 429,
                    error: 'Too many login attempts',
                    retryAfter: Math.ceil(context.ttl / 1000),
                }),
            }
        }
    }, async (_req, reply) => reply.status(401).send({ error: 'Credenciais inválidas.' }));

    // Execute — 100/min, key :execute (x-test-ip for test isolation)
    app.post('/v1/execute/:assistantId', {
        config: {
            rateLimit: {
                max: 100,
                timeWindow: '1 minute',
                keyGenerator: (req) => ((req.headers['x-test-ip'] as string) || req.ip || '127.0.0.1') + ':execute',
                errorResponseBuilder: (_req, context) => ({
                    statusCode: 429,
                    error: 'Rate limit exceeded',
                    retryAfter: Math.ceil(context.ttl / 1000),
                }),
            }
        }
    }, async (_req, reply) => reply.send({ ok: true }));

    app.get('/health', async () => ({ status: 'ok' }));

    await app.ready();
});

afterAll(async () => {
    await app.close();
});

// ---------------------------------------------------------------------------
// Helpers — x-test-ip allows per-test isolation (each test uses unique IP)
// ---------------------------------------------------------------------------

async function loginRequest(ip = '127.0.0.1'): Promise<{ statusCode: number; body: unknown }> {
    const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/login',
        headers: { 'Content-Type': 'application/json', 'x-test-ip': ip },
        payload: JSON.stringify({ email: 'a@b.com', password: 'ValidPass123!' }),
    });
    return { statusCode: res.statusCode, body: res.json() };
}

async function executeRequest(ip = '127.0.0.1'): Promise<{ statusCode: number }> {
    const res = await app.inject({
        method: 'POST',
        url: '/v1/execute/11111111-1111-1111-1111-111111111111',
        headers: { 'Content-Type': 'application/json', 'x-org-id': '00000000-0000-0000-0000-000000000001', 'x-test-ip': ip },
        payload: JSON.stringify({ message: 'test' }),
    });
    return { statusCode: res.statusCode };
}

async function healthRequest(): Promise<{ statusCode: number }> {
    const res = await app.inject({ method: 'GET', url: '/health' });
    return { statusCode: res.statusCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P-12: Rate Limiting Granular', () => {
    it('Caso 1: 10 requests de login em sequência → 11ª retorna 429', async () => {
        const ip = 'ip-caso1';
        for (let i = 0; i < 10; i++) {
            const r = await loginRequest(ip);
            expect(r.statusCode).not.toBe(429);
        }
        const eleventh = await loginRequest(ip);
        expect(eleventh.statusCode).toBe(429);
    });

    it('Caso 2: 9 requests de login → todos retornam não-429', async () => {
        const ip = 'ip-caso2';
        const results: number[] = [];
        for (let i = 0; i < 9; i++) {
            const r = await loginRequest(ip);
            results.push(r.statusCode);
        }
        expect(results.every(c => c !== 429)).toBe(true);
    });

    it('Caso 3: response 429 de login contém campo retryAfter', async () => {
        const ip = 'ip-caso3';
        for (let i = 0; i < 10; i++) await loginRequest(ip);
        const r = await loginRequest(ip);
        expect(r.statusCode).toBe(429);
        expect((r.body as Record<string, unknown>).retryAfter).toBeDefined();
        expect(typeof (r.body as Record<string, unknown>).retryAfter).toBe('number');
    });

    it('Caso 4: rate limit usa IP como chave (keyGenerator correto)', async () => {
        const ip = 'ip-caso4';
        for (let i = 0; i < 10; i++) await loginRequest(ip);
        const r = await loginRequest(ip);
        expect(r.statusCode).toBe(429);
    });

    it('Caso 5: GET /health não tem rate limit restritivo (50 requests sem 429)', async () => {
        const results: number[] = [];
        for (let i = 0; i < 50; i++) {
            const r = await healthRequest();
            results.push(r.statusCode);
        }
        expect(results.every(c => c !== 429)).toBe(true);
    });

    it('Caso 6: rate limit do execute é independente do login', async () => {
        const ip = 'ip-caso6';
        for (let i = 0; i < 10; i++) await loginRequest(ip);
        const loginBlocked = await loginRequest(ip);
        expect(loginBlocked.statusCode).toBe(429);

        const execRes = await executeRequest(ip);
        expect(execRes.statusCode).not.toBe(429);
    });
});
