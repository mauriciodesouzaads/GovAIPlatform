/**
 * GA-011: Assistants contract tests — UI/API schema alignment
 *
 * T1: POST /v1/admin/assistants with name only → 201
 * T2: POST /v1/admin/assistants with name + systemPrompt → 201
 * T3: POST /v1/admin/assistants without name → 400
 * T4: POST /v1/admin/assistants with invalid fields → 400 on name constraint
 * T5: AssistantSchema.parse({ name: 'x' }) → does not throw (systemPrompt has default)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { AssistantSchema, zodErrors } from '../lib/schemas';

const JWT_SECRET = 'assistants-test-jwt-secret-min-32!!';

async function buildAssistantsApp(): Promise<{ app: FastifyInstance; token: string }> {
    const app = Fastify({ logger: false });
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await app.register(fastifyJwt, { secret: JWT_SECRET });

    app.post('/v1/admin/assistants', async (request, reply) => {
        const parsed = AssistantSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'Validation failed', details: zodErrors(parsed.error) });
        }
        return reply.status(201).send({
            id: 'mock-id',
            name: parsed.data.name,
            systemPrompt: parsed.data.systemPrompt,
            status: 'draft',
        });
    });

    await app.ready();
    const token = (app as any).jwt.sign({ role: 'admin', orgId: 'org-001' });
    return { app, token };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GA-011: Assistants contract', () => {
    let app: FastifyInstance;
    let token: string;

    beforeAll(async () => {
        ({ app, token } = await buildAssistantsApp());
    });

    afterAll(async () => {
        await app.close();
    });

    it('T1: POST /v1/admin/assistants with name only → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/assistants',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { name: 'Assistente Jurídico' },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.name).toBe('Assistente Jurídico');
        // systemPrompt should have the default value
        expect(body.systemPrompt).toMatch(/assistente corporativo/);
    });

    it('T2: POST /v1/admin/assistants with name + systemPrompt → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/assistants',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { name: 'Assistente Fiscal', systemPrompt: 'Você é especialista em direito tributário.' },
        });
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).systemPrompt).toBe('Você é especialista em direito tributário.');
    });

    it('T3: POST /v1/admin/assistants without name → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/assistants',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { systemPrompt: 'Sem nome' },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.details.some((d: any) => d.field === 'name')).toBe(true);
    });

    it('T4: POST /v1/admin/assistants with empty name → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/assistants',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            payload: { name: '' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('T5: AssistantSchema.parse({ name: "x" }) does not throw (systemPrompt has default)', () => {
        const result = AssistantSchema.safeParse({ name: 'Minimal' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.systemPrompt).toBeDefined();
            expect(result.data.systemPrompt.length).toBeGreaterThan(0);
        }
    });
});
