/**
 * Tests for policy exceptions CRUD + approval lifecycle.
 * B6 — Sprint B: GOV.AI Core Hardening
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const ASST_ID = '33333333-3333-3333-3333-333333333333';
const EXCEPTION_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const USER_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

// ── Fastify test app factory ──────────────────────────────────────────────────

function buildApp(pgQueryResults: Array<{ rows: any[] }>) {
    const app = Fastify({ logger: false });
    let callIndex = 0;

    const mockPool = {
        connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockImplementation(async () => {
                const result = pgQueryResults[callIndex] ?? { rows: [] };
                callIndex++;
                return result;
            }),
            release: vi.fn(),
        }),
    };

    const requireAdmin = vi.fn().mockImplementation(async (req: any, _reply: any) => {
        req.user = { userId: USER_ID, role: 'admin', orgId: ORG_A };
    });

    // Register only the policy-exceptions routes inline (mirrors admin.routes pattern)
    app.post('/v1/admin/policy-exceptions', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request as any).user?.userId;
        const body = request.body as any;
        const { assistantId, exceptionType, justification, expiresAt } = body ?? {};

        if (!exceptionType || typeof exceptionType !== 'string' || exceptionType.trim().length === 0) {
            return reply.status(400).send({ error: 'exceptionType é obrigatório.' });
        }
        if (!justification || typeof justification !== 'string' || justification.trim().length < 10) {
            return reply.status(400).send({ error: 'justification deve ter pelo menos 10 caracteres.' });
        }
        if (!expiresAt || isNaN(Date.parse(expiresAt))) {
            return reply.status(400).send({ error: 'expiresAt deve ser uma data ISO válida.' });
        }
        if (new Date(expiresAt) <= new Date()) {
            return reply.status(400).send({ error: 'expiresAt deve ser uma data futura.' });
        }

        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('INSERT', [
                orgId, assistantId ?? null, exceptionType.trim(),
                justification.trim(), expiresAt, userId ?? null
            ]);
            return reply.status(201).send(res.rows[0]);
        } finally { client.release(); }
    });

    app.post('/v1/admin/policy-exceptions/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const userId = (request as any).user?.userId;
        const { id } = request.params as { id: string };
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE approve', [userId, id, orgId]);
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Exceção não encontrada ou já processada.' });
            return reply.send(res.rows[0]);
        } finally { client.release(); }
    });

    app.delete('/v1/admin/policy-exceptions/:id', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const reason = body?.reason ?? 'Revogado pelo administrador';
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE revoke', [reason, id, orgId]);
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Exceção não encontrada ou já encerrada.' });
            return reply.send(res.rows[0]);
        } finally { client.release(); }
    });

    return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Policy Exceptions API', () => {
    // T1: POST creates exception with status 'pending'
    it('T1: POST /policy-exceptions creates exception with status pending', async () => {
        const created = {
            id: EXCEPTION_ID,
            org_id: ORG_A,
            assistant_id: ASST_ID,
            exception_type: 'allow_sensitive_topic',
            justification: 'Approved by legal for Q1 pilot',
            expires_at: FUTURE_DATE,
            status: 'pending',
            created_at: new Date().toISOString(),
        };

        const app = buildApp([
            { rows: [] },       // set_config
            { rows: [created] }, // INSERT
        ]);

        const resp = await app.inject({
            method: 'POST',
            url: '/v1/admin/policy-exceptions',
            headers: { 'x-org-id': ORG_A, 'content-type': 'application/json' },
            payload: {
                assistantId: ASST_ID,
                exceptionType: 'allow_sensitive_topic',
                justification: 'Approved by legal for Q1 pilot',
                expiresAt: FUTURE_DATE,
            },
        });

        expect(resp.statusCode).toBe(201);
        const body = JSON.parse(resp.body);
        expect(body.status).toBe('pending');
        expect(body.exception_type).toBe('allow_sensitive_topic');
    });

    // T2: POST /:id/approve transitions to 'approved'
    it('T2: POST /policy-exceptions/:id/approve sets status to approved', async () => {
        const approved = {
            id: EXCEPTION_ID,
            status: 'approved',
            approved_at: new Date().toISOString(),
        };

        const app = buildApp([
            { rows: [] },           // set_config
            { rows: [approved] },   // UPDATE approve
        ]);

        const resp = await app.inject({
            method: 'POST',
            url: `/v1/admin/policy-exceptions/${EXCEPTION_ID}/approve`,
            headers: { 'x-org-id': ORG_A, 'content-type': 'application/json' },
            payload: {},
        });

        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.status).toBe('approved');
        expect(body.approved_at).toBeDefined();
    });

    // T3: DELETE /:id revokes exception
    it('T3: DELETE /policy-exceptions/:id sets status to revoked', async () => {
        const revoked = {
            id: EXCEPTION_ID,
            status: 'revoked',
            revoked_at: new Date().toISOString(),
            revoke_reason: 'Pilot ended',
        };

        const app = buildApp([
            { rows: [] },          // set_config
            { rows: [revoked] },   // UPDATE revoke
        ]);

        const resp = await app.inject({
            method: 'DELETE',
            url: `/v1/admin/policy-exceptions/${EXCEPTION_ID}`,
            headers: { 'x-org-id': ORG_A, 'content-type': 'application/json' },
            payload: { reason: 'Pilot ended' },
        });

        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.status).toBe('revoked');
        expect(body.revoke_reason).toBe('Pilot ended');
    });

    // T4: approve on non-existent ID returns 404
    it('T4: approve on non-existent exception returns 404', async () => {
        const app = buildApp([
            { rows: [] },  // set_config
            { rows: [] },  // UPDATE returns nothing
        ]);

        const resp = await app.inject({
            method: 'POST',
            url: `/v1/admin/policy-exceptions/non-existent-id/approve`,
            headers: { 'x-org-id': ORG_A, 'content-type': 'application/json' },
            payload: {},
        });

        expect(resp.statusCode).toBe(404);
    });

    // T5: validation rejects missing justification
    it('T5: POST rejects request when justification is too short', async () => {
        const app = buildApp([]);

        const resp = await app.inject({
            method: 'POST',
            url: '/v1/admin/policy-exceptions',
            headers: { 'x-org-id': ORG_A, 'content-type': 'application/json' },
            payload: {
                assistantId: ASST_ID,
                exceptionType: 'bypass_hitl',
                justification: 'short',   // < 10 chars
                expiresAt: FUTURE_DATE,
            },
        });

        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body).error).toMatch(/justification/i);
    });
});
