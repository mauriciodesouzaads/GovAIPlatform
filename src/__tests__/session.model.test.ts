/**
 * GA-012: Session model tests — Bearer-only (no cookie)
 *
 * T1: POST /login does not set Set-Cookie header
 * T2: POST /login returns token in body
 * T3: Request without Authorization header returns 401 (no cookie fallback)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../routes/admin.routes';

const JWT_SECRET = 'session-test-jwt-secret-min-32chars!';

vi.mock('../lib/redis', () => ({
    redisCache: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
    },
}));

vi.mock('../lib/mailer', () => ({
    mailer: { sendMail: vi.fn().mockResolvedValue(undefined) },
}));

// ---------------------------------------------------------------------------
// Minimal app with login route
// ---------------------------------------------------------------------------

async function buildLoginApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(fastifyJwt, { secret: JWT_SECRET });

    const mockPool = {
        connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockImplementation((sql: string) => {
                // Step 1: user_lookup returns user_id + org_id
                if (sql.includes('FROM user_lookup')) {
                    return Promise.resolve({
                        rows: [{ user_id: 'user-1', org_id: 'org-1' }],
                    });
                }
                // set_config — no-op
                if (sql.includes('set_config')) {
                    return Promise.resolve({ rows: [] });
                }
                // Step 2: users table returns full user record
                if (sql.includes('FROM users')) {
                    return Promise.resolve({
                        rows: [{
                            id: 'user-1',
                            email: 'admin@orga.com',
                            password_hash: '$2b$12$FpHgLoQgUzoYWNsi1MUjnOrtGx7kWJASqKM0IeeGIg75ozC6xekcm',
                            role: 'admin',
                            org_id: 'org-1',
                            requires_password_change: false,
                        }],
                    });
                }
                return Promise.resolve({ rows: [], rowCount: 0 });
            }),
            release: vi.fn(),
        }),
    };

    const requireAdminAuth = async (_req: any, _reply: any): Promise<void> => {};
    const requireRole = (_roles: string[]) => async (_req: any, _reply: any): Promise<void> => {};

    await app.register(adminRoutes, {
        pgPool: mockPool as any,
        requireAdminAuth,
        requireRole,
    });

    await app.ready();
    return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GA-012: Bearer-only session model', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        app = await buildLoginApp();
    });

    afterAll(async () => {
        await app.close();
    });

    it('T1: POST /login does NOT set Set-Cookie header', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'admin@orga.com', password: 'password' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('T2: POST /login returns token in body', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'admin@orga.com', password: 'password' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.token).toBeDefined();
        expect(typeof body.token).toBe('string');
        expect(body.token.split('.').length).toBe(3); // valid JWT format
    });

    it('T3: Authenticated route without Authorization header → 401', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/stats',
            // No Authorization header, no cookie
        });
        expect(res.statusCode).toBe(401);
    });
});
