/**
 * GA-010: Approvals workflow contract tests
 *
 * T1: POST /approve without body → 400
 * T2: POST /approve with { reviewNote: 'ok' } → not 400 (schema valid)
 * T3: POST /reject with { note: 'x' } → 400 (wrong field name)
 * T4: POST /reject with { reviewNote: 'x' } → not 400 (schema valid)
 * T5: ApprovalActionSchema has reviewNote as required field
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { ApprovalActionSchema, zodErrors } from '../lib/schemas';

const JWT_SECRET = 'approvals-test-jwt-secret-min-32!!';

async function buildApprovalsApp(): Promise<{ app: FastifyInstance; token: string }> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(fastifyJwt, { secret: JWT_SECRET });

    const validateBody = (request: any, reply: any) => {
        const parsed = ApprovalActionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        return reply.status(200).send({ ok: true, reviewNote: parsed.data.reviewNote });
    };

    app.post('/v1/admin/approvals/:approvalId/approve', validateBody);
    app.post('/v1/admin/approvals/:approvalId/reject', validateBody);

    await app.ready();
    const token = (app as any).jwt.sign({ role: 'admin', orgId: 'org-001' });
    return { app, token };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GA-010: Approvals contract', () => {
    let app: FastifyInstance;
    let token: string;

    beforeAll(async () => {
        ({ app, token } = await buildApprovalsApp());
    });

    afterAll(async () => {
        await app.close();
    });

    it('T1: POST /approve without body → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/approvals/approval-123/approve',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: {},
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Validation failed');
    });

    it('T2: POST /approve with { reviewNote: "ok" } → 200 (schema valid)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/approvals/approval-123/approve',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { reviewNote: 'Aprovado pelo administrador' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).reviewNote).toBe('Aprovado pelo administrador');
    });

    it('T3: POST /reject with { note: "x" } → 400 (wrong field name)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/approvals/approval-123/reject',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { note: 'Rejeitado' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('T4: POST /reject with { reviewNote: "x" } → 200 (schema valid)', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/approvals/approval-123/reject',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { reviewNote: 'Rejeitado por política' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('T5: ApprovalActionSchema has reviewNote as required field', () => {
        const validResult = ApprovalActionSchema.safeParse({ reviewNote: 'valid note' });
        expect(validResult.success).toBe(true);

        const missingResult = ApprovalActionSchema.safeParse({});
        expect(missingResult.success).toBe(false);
        expect(missingResult.error!.issues.some(i => i.path[0] === 'reviewNote')).toBe(true);
    });
});
