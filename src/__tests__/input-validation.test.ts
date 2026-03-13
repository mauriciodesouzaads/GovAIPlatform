/**
 * P-08: Input Validation Tests — Zod Schema Enforcement
 *
 * Verifies that all API endpoints with a request body return 400 with a
 * structured `details` array when the input fails schema validation.
 *
 * Strategy:
 *   - Build an in-process Fastify instance with actual route plugins
 *   - Mock pgPool so no real DB connection is needed
 *   - Mock requireAdminAuth / requireRole as pass-through (validation
 *     must fire before or independently of auth)
 *   - Use app.inject() for zero-network overhead
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../routes/admin.routes';
// assistantsRoutes and approvalsRoutes are registered internally by adminRoutes
// (see admin.routes.ts lines 602-606) — do NOT register them again here.

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-input-validation-secret-32ch!!';

const mockClient = {
    query: vi.fn().mockRejectedValue(new Error('Mock DB: test isolation — no real DB needed')),
    release: vi.fn(),
};

const mockPool = {
    connect: vi.fn().mockResolvedValue(mockClient),
} as any;

// Pass-through auth — validation tests must not depend on valid credentials
const requireAdminAuth = async (_req: any, _reply: any): Promise<void> => { /* pass */ };
const requireRole = (_roles: string[]) => async (_req: any, _reply: any): Promise<void> => { /* pass */ };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const JSON_CONTENT = { 'Content-Type': 'application/json' };
const ORG_HEADER = { 'x-org-id': '11111111-1111-1111-1111-111111111111' };

function postBody(path: string, body: unknown) {
    return { method: 'POST' as const, url: path, headers: { ...JSON_CONTENT, ...ORG_HEADER }, payload: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Fastify test instance
// ---------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
    app = Fastify({ logger: false, bodyLimit: 1_048_576 });

    await app.register(fastifyJwt, { secret: JWT_SECRET });
    await app.register(cookie, { secret: 'test-cookie-secret' });

    // adminRoutes registers assistantsRoutes + approvalsRoutes internally
    await app.register(adminRoutes, { pgPool: mockPool, requireAdminAuth, requireRole });

    await app.ready();
});

afterAll(async () => {
    await app.close();
});

// ---------------------------------------------------------------------------
// Helper assertions
// ---------------------------------------------------------------------------

async function expectValidationError(path: string, body: unknown): Promise<void> {
    const res = await app.inject(postBody(path, body));
    expect(res.statusCode, `Expected 400 for ${path} with body ${JSON.stringify(body)}`).toBe(400);
    const json = res.json();
    expect(json.error).toBe('Validation failed');
    expect(Array.isArray(json.details), 'details should be an array').toBe(true);
    expect(json.details.length, 'details should have at least one error').toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /v1/admin/login — LoginSchema', () => {
    it('Caso 1: body {} → 400 (email e password ausentes)', async () => {
        await expectValidationError('/v1/admin/login', {});
    });

    it('Caso 2: email inválido "nao-e-email" → 400', async () => {
        await expectValidationError('/v1/admin/login', { email: 'nao-e-email', password: 'SenhaValida1!' });
    });

    it('Caso 3: password com 3 chars (< min 8) → 400', async () => {
        await expectValidationError('/v1/admin/login', { email: 'user@govai.com', password: 'abc' });
    });

    it('Caso 4: email com 300 chars (> max 254) → 400', async () => {
        const longEmail = 'a'.repeat(250) + '@x.co';
        await expectValidationError('/v1/admin/login', { email: longEmail, password: 'SenhaValida1!' });
    });

    it('Caso 12: email+password válidos → NÃO é 400 (deve ser 401 ou 500)', async () => {
        const res = await app.inject(postBody('/v1/admin/login', { email: 'user@govai.com', password: 'SenhaValida1!' }));
        // Validation passes → reaches DB mock → throws → 500 (or lookup returns empty → 401)
        expect(res.statusCode).not.toBe(400);
    });
});

describe('POST /v1/admin/change-password — ChangePasswordSchema', () => {
    // Note: Zod validation fires BEFORE JWT verification so no token is needed

    it('Caso 5: newPassword sem maiúscula ("semmaiuscula1!") → 400', async () => {
        // all-lowercase + digit + special — zero uppercase letters
        await expectValidationError('/v1/admin/change-password', {
            currentPassword: 'OldPassword1!',
            newPassword: 'semmaiuscula1!',
        });
    });

    it('Caso 6: newPassword sem número ("SemNumero!") → 400', async () => {
        await expectValidationError('/v1/admin/change-password', {
            currentPassword: 'OldPassword1!',
            newPassword: 'SemNumeroAquii!',
        });
    });

    it('Caso 7: newPassword curto ("curto") → 400', async () => {
        await expectValidationError('/v1/admin/change-password', {
            currentPassword: 'OldPassword1!',
            newPassword: 'curto',
        });
    });
});

describe('POST /v1/admin/assistants — CreateAssistantSchema', () => {
    it('Caso 8: body sem name → 400', async () => {
        await expectValidationError('/v1/admin/assistants', {
            systemPrompt: 'Você é um assistente da GovAI.',
        });
    });

    it('Caso 9: systemPrompt com 20000 chars (> max 10000) → 400', async () => {
        await expectValidationError('/v1/admin/assistants', {
            name: 'Assistente Teste',
            systemPrompt: 'x'.repeat(20_000),
        });
    });
});

describe('POST /v1/admin/api-keys — CreateApiKeySchema', () => {
    it('Caso 10: body sem name → 400', async () => {
        await expectValidationError('/v1/admin/api-keys', {});
    });
});

describe('POST /v1/admin/approvals/:id/approve — ApprovalActionSchema', () => {
    it('Caso 11: reviewNote ausente → 400', async () => {
        await expectValidationError('/v1/admin/approvals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/approve', {});
    });
});
