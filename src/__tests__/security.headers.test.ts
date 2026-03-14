/**
 * P-09: Security Headers Tests — Helmet Enforcement
 *
 * Verifies that all HTTP responses include the required security headers
 * configured via @fastify/helmet. Uses inject() for zero-network overhead.
 *
 * Strategy:
 *   - Build an in-process Fastify instance with Helmet FIRST, then routes
 *   - Mock pgPool so no real DB connection is needed
 *   - Same pattern as input-validation.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../routes/admin.routes';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-security-headers-secret-32ch!!';

const mockClient = {
    query: vi.fn().mockRejectedValue(new Error('Mock DB: test isolation')),
    release: vi.fn(),
};

const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
} as any;

const requireAdminAuth = async (_req: any, _reply: any): Promise<void> => { /* pass */ };
const requireRole = (_roles: string[]) => async (_req: any, _reply: any): Promise<void> => { /* pass */ };

// ---------------------------------------------------------------------------
// Fastify test instance — Helmet MUST be first
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
    app = Fastify({ logger: false, bodyLimit: 1_048_576 });

    // P-09: Helmet FIRST — before any route
    await app.register(helmet, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
        },
        frameguard: { action: 'deny' },
        noSniff: true,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    });

    await app.register(fastifyJwt, { secret: JWT_SECRET });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(adminRoutes, { pgPool: mockPool, requireAdminAuth, requireRole });

    // Health route — minimal, no DB
    app.get('/health', async () => ({ status: 'ok', db: 'mocked', redis: 'mocked' }));

    await app.ready();
});

afterAll(async () => {
    await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(res: { headers: Record<string, string | number | string[] | undefined> }, name: string): string | undefined {
    const headers = res.headers as Record<string, string | string[] | undefined>;
    const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? String(headers[key]) : undefined;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('P-09: Security Headers — Helmet', () => {
    it('Caso 1: GET /health → header x-frame-options: DENY presente', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'x-frame-options');
        expect(val?.toUpperCase()).toBe('DENY');
    });

    it('Caso 2: GET /health → header x-content-type-options: nosniff presente', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'x-content-type-options');
        expect(val?.toLowerCase()).toBe('nosniff');
    });

    it('Caso 3: GET /health → header content-security-policy presente e contém "default-src \'self\'"', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'content-security-policy');
        expect(val).toBeDefined();
        expect(val).toContain("default-src 'self'");
    });

    it('Caso 4: GET /health → header strict-transport-security presente e contém max-age=31536000', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'strict-transport-security');
        expect(val).toBeDefined();
        expect(val).toContain('max-age=31536000');
    });

    it('Caso 5: GET /health → header referrer-policy presente', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'referrer-policy');
        expect(val).toBeDefined();
        expect(val?.toLowerCase()).toContain('strict-origin-when-cross-origin');
    });

    it('Caso 6: POST /v1/admin/login com body válido → headers de segurança presentes na resposta (mesmo em 401)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            headers: { 'Content-Type': 'application/json' },
            payload: JSON.stringify({ email: 'user@govai.com', password: 'ValidPassword123!' }),
        });
        // 401 or 500 — mock DB fails, so likely 500
        expect([401, 500]).toContain(res.statusCode);
        expect(header(res, 'x-frame-options')?.toUpperCase()).toBe('DENY');
        expect(header(res, 'x-content-type-options')?.toLowerCase()).toBe('nosniff');
    });

    it('Caso 7: GET /health → header x-powered-by AUSENTE', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'x-powered-by');
        expect(val).toBeUndefined();
    });

    it('Caso 8: GET /health → header server AUSENTE ou não expõe versão (não deve vazar "fastify/4.x")', async () => {
        const res = await app.inject({ method: 'GET', url: '/health' });
        const val = header(res, 'server');
        const leaksVersion = val ? /fastify\/[\d.]+/i.test(val) : false;
        expect(leaksVersion).toBe(false);
    });
});
