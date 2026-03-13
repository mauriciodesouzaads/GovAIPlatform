import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
process.env.SIGNING_SECRET = '0123456789abcdef0123456789abcdef';
import Fastify from 'fastify';
import { assistantsRoutes } from '../routes/assistants.routes';

describe('Assistant Versions Contract (Etapa 2.2)', () => {
    let fastify: any;
    let mockPgPool: any;

    beforeEach(async () => {
        fastify = Fastify();
        // Setup req objects
        const requireAdminAuth = async (req: any, reply: any) => { req.headers['x-org-id'] = 'org-123'; };
        const requireRole = (roles: string[]) => async (req: any, reply: any) => { req.headers['x-org-id'] = 'org-123'; };

        mockPgPool = {
            query: vi.fn(),
            connect: vi.fn().mockResolvedValue({
                query: vi.fn().mockImplementation((q, values) => {
                    if (q.includes('set_config')) return { rowCount: 1 };
                    if (q.includes('BEGIN')) return { rowCount: 1 };
                    if (q.includes('COMMIT')) return { rowCount: 1 };
                    if (q.includes('ROLLBACK')) return { rowCount: 1 };

                    if (q.includes('SELECT name FROM assistants')) {
                        if (values[0] === 'valid-id') return { rowCount: 1, rows: [{ name: 'Test Assistant' }] };
                        return { rowCount: 0, rows: [] };
                    }
                    if (q.includes('INSERT INTO policy_versions')) {
                        return { rowCount: 1, rows: [{ id: 'policy-uuid' }] };
                    }
                    if (q.includes('SELECT COALESCE(MAX(version)')) {
                        return { rowCount: 1, rows: [{ max_v: 2 }] };
                    }
                    if (q.includes('INSERT INTO assistant_versions')) {
                        return { rowCount: 1, rows: [{ id: 'new-ver-uuid' }] };
                    }
                    return { rowCount: 0, rows: [] };
                }),
                release: vi.fn()
            })
        };

        fastify.register(assistantsRoutes, { pgPool: mockPgPool, requireAdminAuth, requireRole });
        await fastify.ready();
    });

    afterEach(async () => {
        await fastify.close();
        vi.restoreAllMocks();
    });

    it('Deve criar nova versão (draft) com policy_json - STATUS 201', async () => {
        const response = await fastify.inject({
            method: 'POST',
            url: '/v1/admin/assistants/valid-id/versions',
            headers: { 'x-org-id': 'org-123' },
            payload: {
                policy_json: { rules: ['no_pii'] }
            }
        });

        expect(response.statusCode).toBe(201);
        const data = JSON.parse(response.payload);
        expect(data).toHaveProperty('id', 'new-ver-uuid');
        expect(data).toHaveProperty('status', 'draft');
        expect(data).toHaveProperty('version', 3); // 2 + 1
    });

    it('Deve falhar se o Assistant não existir - STATUS 404', async () => {
        const response = await fastify.inject({
            method: 'POST',
            url: '/v1/admin/assistants/invalid-id/versions',
            headers: { 'x-org-id': 'org-123' },
            payload: {
                policy_json: { rules: ['no_pii'] }
            }
        });

        expect(response.statusCode).toBe(404);
        const data = JSON.parse(response.payload);
        expect(data.error).toBe('Assistente não encontrado.');
    });

    it('Deve falhar na validação se faltar policy_json - STATUS 400', async () => {
        const response = await fastify.inject({
            method: 'POST',
            url: '/v1/admin/assistants/valid-id/versions',
            headers: { 'x-org-id': 'org-123' },
            payload: {
                something_else: 'value'
            }
        });

        expect(response.statusCode).toBe(400);
        const data = JSON.parse(response.payload);
        expect(data.error).toBe('Campo \'policy_json\' obrigatório.');
    });
});
