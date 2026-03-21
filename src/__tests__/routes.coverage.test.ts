/**
 * P-15: Coverage for assistants.routes.ts and approvals.routes.ts
 *
 * Registers the full adminRoutes plugin (which dynamically imports
 * assistantsRoutes + approvalsRoutes) with a success-returning DB mock.
 * Covers the happy-path branches missed by existing tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../routes/admin.routes';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../lib/redis', () => ({
    redisCache: {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('../lib/dlp-engine', () => ({
    dlpEngine: {
        sanitize: vi.fn().mockReturnValue({ sanitizedText: 'safe text', detections: [] }),
        sanitizeObject: vi.fn().mockResolvedValue({ sanitized: { input: 'safe', output: {} } }),
    },
}));

vi.mock('../workers/audit.worker', () => ({
    auditQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../workers/telemetry.worker', () => ({
    telemetryQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../lib/finops', () => ({
    checkQuota: vi.fn().mockResolvedValue({ exceeded: false, warning: false }),
    recordTokenUsage: vi.fn().mockResolvedValue(undefined),
    getCostPerToken: vi.fn().mockReturnValue(0.000002),
}));

vi.mock('axios', () => ({
    default: {
        post: vi.fn().mockResolvedValue({
            data: {
                choices: [{ message: { content: 'AI response' } }],
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            },
        }),
    },
}));

// ── Test doubles ──────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-routes-coverage-secret-32ch!';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const AST_ID = '22222222-2222-2222-2222-222222222222';
const VER_ID = '33333333-3333-3333-3333-333333333333';

// Mock client that returns relevant success rows based on SQL content
function createSuccessClient() {
    return {
        query: vi.fn().mockImplementation(async (sql: string) => {
            if (sql.includes('set_config') || sql.includes('SET ROLE') || sql.includes('RESET ROLE')) {
                return { rows: [] };
            }
            if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
                return { rows: [] };
            }
            if (sql.includes('FROM assistants') && sql.includes('ORDER BY')) {
                return { rows: [{ id: AST_ID, name: 'Test Assistant', status: 'draft', created_at: new Date(), draft_version_id: null }] };
            }
            if (sql.includes('FROM api_keys')) {
                return { rows: [{ id: 'key-1', name: 'Test Key', prefix: 'test-key-abc', is_active: true, created_at: new Date(), expires_at: null }] };
            }
            if (sql.includes('INSERT INTO api_keys')) {
                return { rows: [{ id: 'key-2', prefix: 'test-key-xyz', created_at: new Date(), expires_at: null }] };
            }
            if (sql.includes('UPDATE api_keys') && sql.includes('is_active')) {
                return { rows: [{ id: 'key-1', revoked_at: new Date(), revoke_reason: 'revoked_by_tenant_admin' }], rowCount: 1 };
            }
            if (sql.includes('FROM policy_versions')) {
                return { rows: [{ id: 'pv-1', name: 'Default Policy', version: 1 }] };
            }
            if (sql.includes('FROM mcp_servers')) {
                return { rows: [{ id: 'mcp-1', name: 'MCP Server', base_url: 'https://mcp.example.com', status: 'active' }] };
            }
            if (sql.includes("INSERT INTO assistants")) {
                return { rows: [{ id: AST_ID, name: 'New Assistant', status: 'draft', created_at: new Date() }] };
            }
            if (sql.includes("INSERT INTO assistant_versions") && sql.includes("RETURNING id")) {
                return { rows: [{ id: VER_ID }] };
            }
            if (sql.includes('SELECT name FROM assistants WHERE id')) {
                return { rows: [{ name: 'Test Assistant' }], rowCount: 1 };
            }
            if (sql.includes('INSERT INTO policy_versions')) {
                return { rows: [{ id: 'pv-2' }] };
            }
            if (sql.includes('COALESCE(MAX(version)')) {
                return { rows: [{ max_v: 1 }] };
            }
            if (sql.includes('UPDATE assistant_versions') && sql.includes('published_by')) {
                return { rows: [{ id: VER_ID }], rowCount: 1 };
            }
            if (sql.includes('UPDATE assistant_versions') && sql.includes('archived')) {
                return { rows: [], rowCount: 0 };
            }
            if (sql.includes('UPDATE assistants') && sql.includes('current_version_id')) {
                return { rows: [], rowCount: 1 };
            }
            // GA-009: approve route SELECT to check version status + already_published
            if (sql.includes('FROM assistant_versions') && sql.includes('already_published')) {
                return { rows: [{ id: VER_ID, status: 'draft', already_published: false }], rowCount: 1 };
            }
            // fallback for old format
            if (sql.includes('SELECT id, status FROM assistant_versions')) {
                return { rows: [{ id: VER_ID, status: 'draft', already_published: false }], rowCount: 1 };
            }
            if (sql.includes('INSERT INTO assistant_publication_events')) {
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('INSERT INTO knowledge_bases')) {
                return { rows: [{ id: 'kb-1', name: 'Base Padrão', created_at: new Date() }] };
            }
            // approvals routes
            if (sql.includes('FROM pending_approvals') && sql.includes('ORDER BY')) {
                return {
                    rows: [
                        { id: 'ap-1', assistant_id: AST_ID, assistant_name: 'Test', message: 'msg', policy_reason: 'dados financeiros de pix cpf', trace_id: 'tr-1', status: 'pending', reviewer_email: null, review_note: null, reviewed_at: null, created_at: new Date() },
                        { id: 'ap-2', assistant_id: AST_ID, assistant_name: 'Test', message: 'msg2', policy_reason: 'email telefone detected', trace_id: 'tr-2', status: 'pending', reviewer_email: null, review_note: null, reviewed_at: null, created_at: new Date() },
                        { id: 'ap-3', assistant_id: AST_ID, assistant_name: 'Test', message: 'msg3', policy_reason: 'injection attempt', trace_id: 'tr-3', status: 'pending', reviewer_email: null, review_note: null, reviewed_at: null, created_at: new Date() },
                        { id: 'ap-4', assistant_id: AST_ID, assistant_name: 'Test', message: 'msg4', policy_reason: 'low risk query', trace_id: 'tr-4', status: 'pending', reviewer_email: null, review_note: null, reviewed_at: null, created_at: new Date() },
                    ],
                };
            }
            if (sql.includes('UPDATE pending_approvals') && sql.includes("status = 'approved'")) {
                return { rows: [{ id: 'ap-1', assistant_id: AST_ID, message: 'safe text', trace_id: 'tr-1', status: 'approved' }] };
            }
            if (sql.includes('UPDATE pending_approvals') && sql.includes("status = 'rejected'")) {
                return { rows: [{ id: 'ap-1', assistant_id: AST_ID, message: 'safe text', trace_id: 'tr-1', status: 'rejected' }] };
            }
            if (sql.includes('SELECT id FROM knowledge_bases')) {
                return { rows: [] };
            }
            return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
    };
}

// Pass-through middleware that also sets req.user so routes using request.user work in tests
const requireAdminAuth = async (req: any, _reply: any): Promise<void> => {
    req.user = { email: 'admin@orga.com', userId: 'admin-user-id', orgId: ORG_ID, role: 'admin' };
};
const requireRole = (_roles: string[]) => async (req: any, _reply: any): Promise<void> => {
    req.user = { email: 'admin@orga.com', userId: 'admin-user-id', orgId: ORG_ID, role: 'admin' };
};

// ── Fastify instance ──────────────────────────────────────────────────────────

let app: FastifyInstance;
let successClient: ReturnType<typeof createSuccessClient>;

beforeAll(async () => {
    process.env.SIGNING_SECRET = 'test-signing-secret-exactly-32ch!';

    successClient = createSuccessClient();
    const mockPool = {
        connect: vi.fn().mockResolvedValue(successClient),
    } as any;

    app = Fastify({ logger: false, bodyLimit: 1_048_576 });
    await app.register(fastifyJwt, { secret: JWT_SECRET });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(adminRoutes, { pgPool: mockPool, requireAdminAuth, requireRole });
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const JSON_H = { 'Content-Type': 'application/json' };
const ORG_H = { 'x-org-id': ORG_ID };
const HEADERS = { ...JSON_H, ...ORG_H };

// ── assistants.routes.ts ──────────────────────────────────────────────────────

describe('assistants.routes.ts — happy paths', () => {

    it('GET /v1/admin/assistants → 200 with list', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/assistants', headers: HEADERS });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body)).toBe(true);
    });

    it('GET /v1/admin/assistants → 401 when x-org-id missing', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/assistants' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /v1/admin/api-keys → 200 with list', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/api-keys', headers: HEADERS });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(JSON.parse(res.body))).toBe(true);
    });

    it('GET /v1/admin/api-keys → 401 when x-org-id missing', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/api-keys', headers: JSON_H });
        expect(res.statusCode).toBe(401);
    });

    it('POST /v1/admin/api-keys → 400 on validation failure (missing name)', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/api-keys',
            headers: HEADERS, payload: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('Validation failed');
    });

    it('POST /v1/admin/api-keys → 201 on valid request', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/api-keys',
            headers: HEADERS,
            payload: JSON.stringify({ name: 'My Key' }),
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.key).toMatch(/^sk-/);
        expect(body.warning).toBeDefined();
    });

    it('POST /v1/admin/api-keys → 401 when x-org-id missing', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/api-keys',
            headers: JSON_H, payload: JSON.stringify({ name: 'Key' }),
        });
        expect(res.statusCode).toBe(401);
    });

    it('DELETE /v1/admin/api-keys/:keyId → 200 on revoke', async () => {
        const res = await app.inject({
            method: 'DELETE', url: '/v1/admin/api-keys/key-1',
            headers: ORG_H,
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).message).toContain('revogada');
    });

    it('DELETE /v1/admin/api-keys/:keyId → 401 when x-org-id missing', async () => {
        const res = await app.inject({ method: 'DELETE', url: '/v1/admin/api-keys/key-1' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /v1/admin/policy_versions → 200', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/policy_versions', headers: HEADERS });
        expect(res.statusCode).toBe(200);
    });

    it('GET /v1/admin/mcp_servers → 200', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/mcp_servers', headers: HEADERS });
        expect(res.statusCode).toBe(200);
    });

    it('POST /v1/admin/assistants → 400 on validation failure', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/assistants',
            headers: HEADERS, payload: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /v1/admin/assistants → 201 with valid name and systemPrompt', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/assistants',
            headers: HEADERS,
            payload: JSON.stringify({ name: 'New Assistant', systemPrompt: 'You are a helpful assistant.' }),
        });
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).name).toBe('New Assistant');
    });

    it('POST /v1/admin/assistants → 201 with policy_version_id (creates version)', async () => {
        const res = await app.inject({
            method: 'POST', url: '/v1/admin/assistants',
            headers: HEADERS,
            payload: JSON.stringify({ name: 'Full Assistant', systemPrompt: 'You are helpful.', policy_version_id: 'pv-1' }),
        });
        expect(res.statusCode).toBe(201);
    });

    it('POST /v1/admin/assistants/:id/versions → 400 when policy_json missing', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/versions`,
            headers: HEADERS, payload: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /v1/admin/assistants/:id/versions → 201 with policy_json', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/versions`,
            headers: HEADERS,
            payload: JSON.stringify({ policy_json: { pii_filter: true } }),
        });
        expect(res.statusCode).toBe(201);
    });

    it('POST /v1/admin/assistants/:id/versions/:vId/approve → 400 when checklist empty', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/versions/${VER_ID}/approve`,
            headers: HEADERS, payload: JSON.stringify({ checklist: {} }),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toContain('checklist');
    });

    it('POST /v1/admin/assistants/:id/versions/:vId/approve → 200 with full checklist', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/versions/${VER_ID}/approve`,
            headers: HEADERS,
            payload: JSON.stringify({ checklist: { security: true, compliance: true, testing: true } }),
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).success).toBe(true);
    });

    it('POST /v1/admin/assistants/:id/knowledge → 201', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/knowledge`,
            headers: HEADERS, payload: JSON.stringify({ name: 'KB Padrão' }),
        });
        expect(res.statusCode).toBe(201);
    });

    it('POST /v1/admin/assistants/:id/knowledge → 401 when x-org-id missing', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${AST_ID}/knowledge`,
            headers: JSON_H, payload: JSON.stringify({ name: 'KB' }),
        });
        expect(res.statusCode).toBe(401);
    });
});

// ── approvals.routes.ts ───────────────────────────────────────────────────────

describe('approvals.routes.ts — happy paths', () => {

    it('GET /v1/admin/approvals → 200 with rows (covers all risk_level branches)', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/approvals', headers: HEADERS });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body)).toBe(true);
        // risk_level branches: high (pix/cpf/senha), medium (email/telefone), high (financeiro/injection), low
        const levels = body.map((r: any) => r.risk_level);
        expect(levels).toContain('high');
        expect(levels).toContain('medium');
        expect(levels).toContain('low');
    });

    it('GET /v1/admin/approvals → 401 when x-org-id missing', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/approvals' });
        expect(res.statusCode).toBe(401);
    });

    it('GET /v1/admin/approvals?status=approved → 200', async () => {
        const res = await app.inject({
            method: 'GET', url: '/v1/admin/approvals?status=approved', headers: HEADERS,
        });
        expect(res.statusCode).toBe(200);
    });

    it('POST /v1/admin/approvals/:id/approve → 400 on validation failure (empty body)', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/approve`,
            headers: HEADERS, payload: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('Validation failed');
    });

    it('POST /v1/admin/approvals/:id/approve → 401 when x-org-id missing', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/approve`,
            headers: JSON_H, payload: JSON.stringify({ reviewNote: 'ok' }),
        });
        expect(res.statusCode).toBe(401);
    });

    it('POST /v1/admin/approvals/:id/approve → 200 on valid approval', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/approve`,
            headers: HEADERS, payload: JSON.stringify({ reviewNote: 'Approved' }),
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).status).toBe('APPROVED_AND_EXECUTED');
    });

    it('POST /v1/admin/approvals/:id/reject → 400 on validation failure', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/reject`,
            headers: HEADERS, payload: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /v1/admin/approvals/:id/reject → 401 when x-org-id missing', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/reject`,
            headers: JSON_H, payload: JSON.stringify({ reviewNote: 'no' }),
        });
        expect(res.statusCode).toBe(401);
    });

    it('POST /v1/admin/approvals/:id/reject → 200 on valid rejection', async () => {
        const res = await app.inject({
            method: 'POST', url: `/v1/admin/approvals/ap-1/reject`,
            headers: HEADERS, payload: JSON.stringify({ reviewNote: 'Rejected - policy violation' }),
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).status).toBe('REJECTED');
    });
});
