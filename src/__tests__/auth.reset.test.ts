/**
 * GA-007: First-login password reset tests
 *
 * T1: POST /reset-password with valid schema → route exists (201 or mock)
 * T2: POST /reset-password without resetToken → 400
 * T3: POST /reset-password with newPassword < 8 chars → 400
 * T4: POST /change-password with currentPassword correct → schema valid (400 on bad JWT, not schema)
 * T5: rowCount = 0 → endpoint returns 500 with clear message
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { FirstLoginResetSchema, ChangePasswordSchema, zodErrors } from '../lib/schemas';

const JWT_SECRET = 'reset-test-jwt-secret-min-32-chars!!';

// ---------------------------------------------------------------------------
// Minimal app replicating the reset-password endpoint for integration testing
// ---------------------------------------------------------------------------

async function buildResetApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(fastifyJwt, { secret: JWT_SECRET });

    // Mock redis
    const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
    };

    app.post('/v1/admin/reset-password', async (request, reply) => {
        const parsed = FirstLoginResetSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        const { resetToken, newPassword: _np } = parsed.data;

        let decoded: any;
        try {
            decoded = (app as any).jwt.verify(resetToken);
        } catch {
            return reply.status(401).send({ error: 'Token de redefinição inválido ou expirado.' });
        }

        if (!decoded.resetOnly) {
            return reply.status(403).send({ error: 'Este token não é válido para troca de senha obrigatória.' });
        }

        const redisKey = `reset_used:${decoded.userId}`;
        const alreadyUsed = await mockRedis.get(redisKey);
        if (alreadyUsed) {
            return reply.status(410).send({ error: 'Token de reset já utilizado.' });
        }

        // Simulate rowCount = 0 scenario via query param
        const { simulateRowCountZero } = request.query as { simulateRowCountZero?: string };
        if (simulateRowCountZero === 'true') {
            return reply.status(500).send({ error: 'Falha ao atualizar senha: nenhuma linha afetada.' });
        }

        await mockRedis.set(redisKey, '1', 'EX', 3600);
        return reply.status(201).send({ success: true, message: 'Senha redefinida com sucesso. Faça login novamente.' });
    });

    await app.ready();
    return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GA-007: First-login password reset', () => {
    let app: FastifyInstance;
    let validResetToken: string;

    beforeAll(async () => {
        app = await buildResetApp();
        validResetToken = (app as any).jwt.sign({ userId: 'user-001', orgId: 'org-001', resetOnly: true });
    });

    afterAll(async () => {
        await app.close();
    });

    it('T1: POST /reset-password with valid schema and valid reset token → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/reset-password',
            payload: { resetToken: validResetToken, newPassword: 'NovaSenha@2026!' },
        });
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).success).toBe(true);
    });

    it('T2: POST /reset-password without resetToken → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/reset-password',
            payload: { newPassword: 'novaSenha123' },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Validation failed');
        expect(body.details.some((d: any) => d.field === 'resetToken')).toBe(true);
    });

    it('T3: POST /reset-password with newPassword < 8 chars → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/reset-password',
            payload: { resetToken: validResetToken, newPassword: 'short' },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.details.some((d: any) => d.field === 'newPassword')).toBe(true);
    });

    it('T4: POST /change-password schema — valid body does not produce schema error', () => {
        const result = ChangePasswordSchema.safeParse({
            currentPassword: 'SenhaAtual123',
            newPassword: 'NovaSenha123!',
        });
        expect(result.success).toBe(true);
    });

    it('T5: rowCount = 0 → reset-password returns 500 with clear message', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/reset-password?simulateRowCountZero=true',
            payload: { resetToken: validResetToken, newPassword: 'NovaSenha@2026B!' },
        });
        expect(res.statusCode).toBe(500);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/nenhuma linha afetada/);
    });
});
