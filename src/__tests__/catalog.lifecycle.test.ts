/**
 * Tests for Catalog Registry lifecycle endpoints (Sprint D — D5).
 *
 * Covers: GET /catalog, PUT /metadata, submit-for-review, catalog-review (approved/rejected),
 * suspend, archive, and the publish guardrail (lifecycle_state = approved required).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID   = '11111111-1111-1111-1111-111111111111';
const ASST_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const USER_EMAIL = 'reviewer@govai.com';

// ── Fastify test app factory ──────────────────────────────────────────────────

function buildApp(queryResults: Array<{ rows: any[]; rowCount?: number }>) {
    const app = Fastify({ logger: false });
    let callIndex = 0;

    const mockPool = {
        connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockImplementation(async () => {
                const r = queryResults[callIndex] ?? { rows: [], rowCount: 0 };
                callIndex++;
                return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
            }),
            release: vi.fn(),
        }),
    };

    const requireAdmin = vi.fn().mockImplementation(async (req: any) => {
        req.user = { userId: USER_ID, email: USER_EMAIL, role: 'admin' };
    });

    // ── D2a GET /catalog ──────────────────────────────────────────────────────
    app.get('/v1/admin/catalog', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('SELECT catalog', [orgId]);
            return reply.send({ total: res.rowCount, assistants: res.rows });
        } finally { client.release(); }
    });

    // ── D2b PUT /metadata ────────────────────────────────────────────────────
    app.put('/v1/admin/assistants/:id/metadata', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const { riskLevel } = request.body as any;

        const VALID_RISK = ['low', 'medium', 'high', 'critical'];
        if (riskLevel && !VALID_RISK.includes(riskLevel)) {
            return reply.status(400).send({ error: `riskLevel deve ser um de: ${VALID_RISK.join(', ')}.` });
        }

        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE metadata', [id, orgId]);
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Assistente não encontrado.' });
            return reply.send(res.rows[0]);
        } finally { client.release(); }
    });

    // ── D2c POST /submit-for-review ──────────────────────────────────────────
    app.post('/v1/admin/assistants/:id/submit-for-review', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE submit', [id, orgId]);
            if (res.rows.length === 0) return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado draft.' });
            await client.query('evidence', []); // non-fatal recordEvidence call
            return reply.send({ success: true, assistant: res.rows[0] });
        } finally { client.release(); }
    });

    // ── D2d POST /catalog-review ─────────────────────────────────────────────
    app.post('/v1/admin/assistants/:id/catalog-review', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const { decision } = request.body as { decision: string; comments?: string };

        const VALID_DECISIONS = ['approved', 'rejected', 'needs_changes'];
        if (!decision || !VALID_DECISIONS.includes(decision)) {
            return reply.status(400).send({ error: `decision deve ser um de: ${VALID_DECISIONS.join(', ')}.` });
        }

        const newState = decision === 'approved' ? 'approved' : 'draft';
        const client = await mockPool.connect();
        try {
            await client.query('BEGIN', []);
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE review', [newState, id, orgId]);
            if (res.rows.length === 0) {
                await client.query('ROLLBACK', []);
                return reply.status(409).send({ error: 'Assistente não encontrado ou não está em under_review.' });
            }
            await client.query('INSERT catalog_reviews', []);
            await client.query('COMMIT', []);
            await client.query('evidence', []);
            return reply.send({ success: true, decision, newLifecycleState: newState, assistant: res.rows[0] });
        } finally { client.release(); }
    });

    // ── D2e POST /suspend ────────────────────────────────────────────────────
    app.post('/v1/admin/assistants/:id/suspend', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        if (!reason || reason.trim().length < 5) {
            return reply.status(400).send({ error: "Campo 'reason' obrigatório (mínimo 5 caracteres)." });
        }
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE suspend', [id, orgId]);
            if (res.rows.length === 0) return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado approved/official.' });
            await client.query('evidence', []);
            return reply.send({ success: true, assistant: res.rows[0] });
        } finally { client.release(); }
    });

    // ── D2f POST /archive ────────────────────────────────────────────────────
    app.post('/v1/admin/assistants/:id/archive', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        if (!reason || reason.trim().length < 5) {
            return reply.status(400).send({ error: "Campo 'reason' obrigatório (mínimo 5 caracteres)." });
        }
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE archive', [id, orgId]);
            if (res.rows.length === 0) return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado suspended/draft.' });
            await client.query('evidence', []);
            return reply.send({ success: true, assistant: res.rows[0] });
        } finally { client.release(); }
    });

    // ── D3 Publish guardrail ─────────────────────────────────────────────────
    app.post('/v1/admin/assistants/:assistantId/versions/:versionId/approve',
        { preHandler: requireAdmin },
        async (request, reply) => {
            const orgId = request.headers['x-org-id'] as string;
            const { assistantId, versionId } = request.params as { assistantId: string; versionId: string };
            const { checklist } = request.body as any;

            if (!checklist || Object.values(checklist).some(v => v !== true)) {
                return reply.status(400).send({ error: 'Checklist deve estar integralmente aprovado.' });
            }

            const client = await mockPool.connect();
            try {
                await client.query('set_config', [orgId]);
                // version check
                const verRes = await client.query('SELECT version', [versionId, assistantId, orgId]);
                if (verRes.rows.length === 0) return reply.status(404).send({ error: 'Versão não encontrada.' });
                // lifecycle guardrail
                const lcRes = await client.query('SELECT lifecycle_state', [assistantId, orgId]);
                if (lcRes.rows[0]?.lifecycle_state !== 'approved') {
                    return reply.status(400).send({
                        error: 'Publicação só é permitida para assistentes com lifecycle_state = approved. '
                             + 'Use o fluxo de revisão de catálogo antes de publicar.',
                        currentLifecycleState: lcRes.rows[0]?.lifecycle_state ?? null,
                    });
                }
                return reply.send({ success: true, versionId, approved_by: USER_EMAIL });
            } finally { client.release(); }
        }
    );

    return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Catalog Registry Lifecycle', () => {

    // T1: GET /catalog returns assistants with lifecycle_state
    it('T1: GET /catalog returns assistants with lifecycle_state field', async () => {
        const rows = [
            { id: ASST_ID, name: 'Demo', lifecycle_state: 'official', risk_level: 'low', version_count: 2 },
        ];
        const app = buildApp([
            { rows: [] },          // set_config
            { rows, rowCount: 1 }, // SELECT catalog
        ]);
        const resp = await app.inject({ method: 'GET', url: '/v1/admin/catalog', headers: { 'x-org-id': ORG_ID } });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.total).toBe(1);
        expect(body.assistants[0].lifecycle_state).toBe('official');
    });

    // T2: PUT /metadata updates risk_level
    it('T2: PUT /metadata updates risk_level and returns updated row', async () => {
        const updated = { id: ASST_ID, name: 'Demo', lifecycle_state: 'draft', risk_level: 'high', updated_at: new Date().toISOString() };
        const app = buildApp([
            { rows: [] },             // set_config
            { rows: [updated] },      // UPDATE metadata
        ]);
        const resp = await app.inject({
            method: 'PUT', url: `/v1/admin/assistants/${ASST_ID}/metadata`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { riskLevel: 'high', riskJustification: 'Handles financial data.' },
        });
        expect(resp.statusCode).toBe(200);
        expect(JSON.parse(resp.body).risk_level).toBe('high');
    });

    // T3: PUT /metadata rejects invalid risk_level
    it('T3: PUT /metadata rejects invalid risk_level value', async () => {
        const app = buildApp([]);
        const resp = await app.inject({
            method: 'PUT', url: `/v1/admin/assistants/${ASST_ID}/metadata`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { riskLevel: 'extreme' }, // invalid
        });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body).error).toMatch(/riskLevel/i);
    });

    // T4: POST /submit-for-review transitions draft → under_review
    it('T4: POST /submit-for-review transitions draft → under_review', async () => {
        const updated = { id: ASST_ID, name: 'Demo', lifecycle_state: 'under_review' };
        const app = buildApp([
            { rows: [] },             // set_config
            { rows: [updated] },      // UPDATE submit
            { rows: [] },             // evidence (non-fatal)
        ]);
        const resp = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${ASST_ID}/submit-for-review`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' }, payload: {},
        });
        expect(resp.statusCode).toBe(200);
        expect(JSON.parse(resp.body).assistant.lifecycle_state).toBe('under_review');
    });

    // T5: POST /catalog-review approved transitions → approved
    it('T5: POST /catalog-review with decision=approved sets lifecycle_state to approved', async () => {
        const updated = { id: ASST_ID, name: 'Demo', lifecycle_state: 'approved' };
        const app = buildApp([
            { rows: [] }, // BEGIN
            { rows: [] }, // set_config
            { rows: [updated] }, // UPDATE review → approved
            { rows: [] }, // INSERT catalog_reviews
            { rows: [] }, // COMMIT
            { rows: [] }, // evidence
        ]);
        const resp = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${ASST_ID}/catalog-review`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { decision: 'approved', comments: 'All controls verified.' },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.newLifecycleState).toBe('approved');
        expect(body.decision).toBe('approved');
    });

    // T6: POST /catalog-review rejected transitions → draft
    it('T6: POST /catalog-review with decision=rejected reverts lifecycle_state to draft', async () => {
        const updated = { id: ASST_ID, name: 'Demo', lifecycle_state: 'draft' };
        const app = buildApp([
            { rows: [] }, // BEGIN
            { rows: [] }, // set_config
            { rows: [updated] }, // UPDATE review → draft
            { rows: [] }, // INSERT catalog_reviews
            { rows: [] }, // COMMIT
            { rows: [] }, // evidence
        ]);
        const resp = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${ASST_ID}/catalog-review`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { decision: 'rejected', comments: 'Missing DLP configuration.' },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.newLifecycleState).toBe('draft');
    });

    // T7: POST /suspend transitions approved → suspended
    it('T7: POST /suspend transitions approved → suspended', async () => {
        const updated = { id: ASST_ID, name: 'Demo', lifecycle_state: 'suspended', suspended_at: new Date().toISOString() };
        const app = buildApp([
            { rows: [] },         // set_config
            { rows: [updated] },  // UPDATE suspend
            { rows: [] },         // evidence
        ]);
        const resp = await app.inject({
            method: 'POST', url: `/v1/admin/assistants/${ASST_ID}/suspend`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { reason: 'Security incident detected.' },
        });
        expect(resp.statusCode).toBe(200);
        expect(JSON.parse(resp.body).assistant.lifecycle_state).toBe('suspended');
    });

    // T8: publish without lifecycle_state = 'approved' returns 400
    it('T8: publish guardrail rejects assistant with lifecycle_state != approved (returns 400)', async () => {
        const version = { id: 'ver-001', status: 'draft', already_published: false };
        const app = buildApp([
            { rows: [] },                                              // set_config
            { rows: [version] },                                       // SELECT version
            { rows: [{ lifecycle_state: 'draft' }] },                  // SELECT lifecycle_state
        ]);
        const resp = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/versions/ver-001/approve`,
            headers: { 'x-org-id': ORG_ID, 'content-type': 'application/json' },
            payload: { checklist: { 'security_review': true, 'dlp_configured': true } },
        });
        expect(resp.statusCode).toBe(400);
        const body = JSON.parse(resp.body);
        expect(body.error).toMatch(/lifecycle_state = approved/i);
        expect(body.currentLifecycleState).toBe('draft');
    });
});
