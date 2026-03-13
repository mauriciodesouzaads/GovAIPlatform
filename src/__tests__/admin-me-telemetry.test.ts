/**
 * Admin Identity & Telemetry Consent — Integration Tests (DT-G-05 + DT-G-01/02/03 + DT-H-03/05)
 *
 * Covers:
 *   - GET /v1/admin/me: autenticado (JWT Bearer + httpOnly cookie), sem token, token inválido
 *   - GET /v1/admin/organizations/:id/telemetry-consent: leitura individual (DT-H-03)
 *   - PUT /v1/admin/organizations/:id/telemetry-consent: grant, revoke, validação, 404,
 *       audit log HMAC-SHA256 persistido em audit_logs_partitioned (DT-H-05)
 *   - GET /v1/admin/organizations/telemetry-consented: lista apenas orgs com consent = TRUE
 *
 * Pattern: Fastify in-process com mock pg.Pool (sem DB real).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { adminRoutes } from '../routes/admin.routes';

// ─── Mock pg.Pool ─────────────────────────────────────────────────────────────

const ORG_WITH_CONSENT = {
    id: 'org-aaa',
    name: 'Org Alpha',
    status: 'active',
    created_at: new Date('2025-01-01'),
    telemetry_consent: true,
    telemetry_consent_at: new Date('2025-06-01'),
    telemetry_pii_strip: false,
};

const ORG_WITHOUT_CONSENT = {
    id: 'org-bbb',
    name: 'Org Beta',
    status: 'active',
    created_at: new Date('2025-02-01'),
    telemetry_consent: false,
    telemetry_consent_at: null,
    telemetry_pii_strip: true,
};

// Tracks SQL queries issued against the mock client for assertion
const capturedSql: Array<{ sql: string; params: any[] }> = [];

function buildMockPool() {
    const routeQuery = async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        capturedSql.push({ sql: s, params });

        // Transaction control
        if (/^(begin|commit|rollback)$/.test(s)) return { rows: [] };

        // telemetry-consented list
        if (s.includes('where o.telemetry_consent = true')) {
            return { rows: [{ ...ORG_WITH_CONSENT, consented_by_email: 'admin@test.com' }] };
        }
        // All organizations
        if (s.includes('from organizations') && s.includes('telemetry_consent') && !s.includes('where')) {
            return { rows: [ORG_WITH_CONSENT, ORG_WITHOUT_CONSENT] };
        }
        // GET :id/telemetry-consent (individual org lookup with JOIN)
        if (s.includes('from organizations o') && s.includes('left join users u') && s.includes('where o.id =')) {
            const id = params[0];
            if (id === 'org-aaa') {
                return { rows: [{ ...ORG_WITH_CONSENT, consented_by_email: 'admin@test.com' }] };
            }
            return { rows: [] };
        }
        // Org existence check for PUT telemetry update
        if (s.includes('select id, name from organizations where id')) {
            if (params[0] === 'org-aaa') return { rows: [{ id: 'org-aaa', name: 'Org Alpha' }] };
            if (params[0] === 'org-notexist') return { rows: [] };
        }
        // Update telemetry consent
        if (s.includes('update organizations') && s.includes('telemetry_consent')) {
            return { rows: [], rowCount: 1 };
        }
        // Audit log INSERT
        if (s.includes('insert into audit_logs_partitioned')) {
            return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
    };

    return {
        query: vi.fn(routeQuery),
        connect: vi.fn(async () => ({
            query: vi.fn(routeQuery),
            release: vi.fn(),
        })),
    };
}

// ─── Test App Factory ─────────────────────────────────────────────────────────

const JWT_SECRET = 'test-me-secret-32chars-minimum!!X';

async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.register(fastifyJwt, { secret: JWT_SECRET });
    app.register(cookie, { secret: 'test-cookie-secret' });

    const pool = buildMockPool();

    const requireAdminAuth = async (request: any, reply: any) => {
        try {
            // Try httpOnly cookie first, then Authorization header
            const rawToken = request.cookies?.token;
            if (rawToken) {
                request.user = app.jwt.verify(rawToken);
            } else {
                await request.jwtVerify();
            }
        } catch {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
    };

    const requireRole = (roles: string[]) => async (request: any, reply: any) => {
        try {
            const rawToken = request.cookies?.token;
            if (rawToken) {
                request.user = app.jwt.verify(rawToken);
            } else {
                await request.jwtVerify();
            }
            if (!roles.includes((request.user as any).role)) {
                return reply.status(403).send({ error: 'Forbidden' });
            }
        } catch {
            return reply.status(401).send({ error: 'Unauthorized' });
        }
    };

    app.register(adminRoutes, { pgPool: pool as any, requireAdminAuth, requireRole });
    await app.ready();
    return app;
}

function makeToken(app: FastifyInstance, payload: object = {}) {
    return app.jwt.sign({
        email: 'admin@govai.com',
        role: 'admin',
        orgId: 'org-aaa',
        userId: 'usr-111',
        ...payload,
    }, { expiresIn: '1h' });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
    process.env.SIGNING_SECRET = 'test-signing-secret-for-tests-min32chars!!';
    app = await buildApp();
});
afterAll(async () => {
    await app.close();
    delete process.env.SIGNING_SECRET;
});

beforeEach(() => {
    // Reset SQL capture between tests
    capturedSql.length = 0;
});

// ─── GET /v1/admin/me ─────────────────────────────────────────────────────────

describe('GET /v1/admin/me', () => {

    it('returns user claims when authenticated via Bearer token', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/me',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.email).toBe('admin@govai.com');
        expect(body.role).toBe('admin');
        expect(body.orgId).toBe('org-aaa');
        expect(body.userId).toBe('usr-111');
    });

    it('returns user claims when authenticated via httpOnly cookie', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/me',
            cookies: { token },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.email).toBe('admin@govai.com');
        expect(body.role).toBe('admin');
    });

    it('returns 401 when no token is provided', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/admin/me' });
        expect(res.statusCode).toBe(401);
    });

    it('returns 401 when token is invalid/expired', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/me',
            headers: { authorization: 'Bearer this.is.invalid' },
        });
        expect(res.statusCode).toBe(401);
    });

    it('returns null for absent optional fields (dpo user without orgId)', async () => {
        const token = app.jwt.sign({
            email: 'dpo@govai.com',
            role: 'dpo',
        }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/me',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.email).toBe('dpo@govai.com');
        expect(body.role).toBe('dpo');
        expect(body.orgId).toBeNull();
        expect(body.userId).toBeNull();
    });
});

// ─── PUT /v1/admin/organizations/:id/telemetry-consent ────────────────────────

describe('PUT /v1/admin/organizations/:id/telemetry-consent', () => {

    it('grants consent and returns updated state', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true, pii_strip: false },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.org_id).toBe('org-aaa');
        expect(body.telemetry_consent).toBe(true);
        expect(body.telemetry_pii_strip).toBe(false);
        expect(body.telemetry_consent_at).toBeTruthy();
        expect(body.updated_by).toBe('usr-111');
    });

    it('revokes consent and clears consent_at/by', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: false, pii_strip: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.telemetry_consent).toBe(false);
        expect(body.telemetry_consent_at).toBeNull();
    });

    it('uses pii_strip=true as default when not provided', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.telemetry_pii_strip).toBe(true);
    });

    it('returns 400 when consent field is missing', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { pii_strip: true },
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/consent/i);
    });

    it('returns 404 when organization does not exist', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-notexist/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: { 'content-type': 'application/json' },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(401);
    });

    it('returns 403 for non-admin/dpo role (operator)', async () => {
        const token = app.jwt.sign({ email: 'op@govai.com', role: 'operator', orgId: 'org-aaa' }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(403);
    });
});

// ─── GET /v1/admin/organizations/:id/telemetry-consent ───────────────────────

describe('GET /v1/admin/organizations/:id/telemetry-consent', () => {

    it('returns consent state for a specific org (admin)', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe('org-aaa');
        expect(body.telemetry_consent).toBe(true);
        expect(body.telemetry_pii_strip).toBe(false);
        expect(body.consented_by_email).toBe('admin@test.com');
    });

    it('returns 404 for unknown org', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/org-unknown/telemetry-consent',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(404);
    });

    it('dpo can read individual org consent', async () => {
        const token = app.jwt.sign({ email: 'dpo@govai.com', role: 'dpo' }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
    });

    it('returns 403 for operator role', async () => {
        const token = app.jwt.sign({ email: 'op@govai.com', role: 'operator' }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
    });
});

// ─── GET /v1/admin/organizations/telemetry-consented ─────────────────────────

describe('GET /v1/admin/organizations/telemetry-consented', () => {

    it('returns only organizations with consent = TRUE', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/telemetry-consented',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.total).toBe(1);
        expect(body.organizations).toHaveLength(1);
        expect(body.organizations[0].id).toBe('org-aaa');
        expect(body.organizations[0].telemetry_consent).toBe(true);
    });

    it('returns 401 without authentication', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/telemetry-consented',
        });
        expect(res.statusCode).toBe(401);
    });

    it('returns 403 for operator role (insufficient privilege)', async () => {
        const token = app.jwt.sign({ email: 'op@govai.com', role: 'operator' }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/telemetry-consented',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(403);
    });

    it('dpo role can access compliance list', async () => {
        const token = app.jwt.sign({ email: 'dpo@govai.com', role: 'dpo', orgId: 'org-aaa' }, { expiresIn: '1h' });
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/organizations/telemetry-consented',
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.total).toBeDefined();
    });
});

// ─── Audit Log persistence (DT-H-05) ─────────────────────────────────────────

describe('PUT telemetry-consent — HMAC audit log (DT-H-05)', () => {

    it('persists audit log INSERT in audit_logs_partitioned on grant', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true, pii_strip: true },
        });
        expect(res.statusCode).toBe(200);

        // Verify BEGIN + UPDATE + INSERT + COMMIT were issued
        const sqls = capturedSql.map(q => q.sql);
        expect(sqls).toContain('begin');
        expect(sqls.some(s => s.includes('update organizations'))).toBe(true);
        expect(sqls.some(s => s.includes('insert into audit_logs_partitioned'))).toBe(true);
        expect(sqls).toContain('commit');
    });

    it('includes audit_log_id in the response', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.audit_log_id).toBeDefined();
        expect(typeof body.audit_log_id).toBe('string');
        // Should be a valid UUID v4
        expect(body.audit_log_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('persists ROLLBACK on 404 — no audit log for non-existent org', async () => {
        const token = makeToken(app);
        const res = await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-notexist/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });
        expect(res.statusCode).toBe(404);

        const sqls = capturedSql.map(q => q.sql);
        expect(sqls).toContain('begin');
        expect(sqls).toContain('rollback');
        expect(sqls.some(s => s.includes('insert into audit_logs_partitioned'))).toBe(false);
    });

    it('audit log INSERT contains correct action type on revoke', async () => {
        const token = makeToken(app);
        await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: false },
        });

        const auditInsert = capturedSql.find(q => q.sql.includes('insert into audit_logs_partitioned'));
        expect(auditInsert).toBeDefined();
        // params[1] is the action type
        expect(auditInsert!.params[1]).toBe('TELEMETRY_CONSENT_REVOKED');
    });

    it('audit log INSERT contains correct action type on grant', async () => {
        const token = makeToken(app);
        await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });

        const auditInsert = capturedSql.find(q => q.sql.includes('insert into audit_logs_partitioned'));
        expect(auditInsert).toBeDefined();
        expect(auditInsert!.params[1]).toBe('TELEMETRY_CONSENT_GRANTED');
    });

    it('metadata JSON contains org_id, consent and pii_strip fields', async () => {
        const token = makeToken(app);
        await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true, pii_strip: false },
        });

        const auditInsert = capturedSql.find(q => q.sql.includes('insert into audit_logs_partitioned'));
        expect(auditInsert).toBeDefined();
        // params[2] is the metadata JSON string
        const metadata = JSON.parse(auditInsert!.params[2]);
        expect(metadata.org_id).toBe('org-aaa');
        expect(metadata.consent).toBe(true);
        expect(metadata.pii_strip).toBe(false);
        expect(metadata.performed_by_user_id).toBe('usr-111');
    });

    it('signature param is a 64-char hex string (HMAC-SHA256)', async () => {
        const token = makeToken(app);
        await app.inject({
            method: 'PUT',
            url: '/v1/admin/organizations/org-aaa/telemetry-consent',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            payload: { consent: true },
        });

        const auditInsert = capturedSql.find(q => q.sql.includes('insert into audit_logs_partitioned'));
        // params[3] is the HMAC-SHA256 signature
        const signature = auditInsert!.params[3];
        expect(typeof signature).toBe('string');
        expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });
});
