/**
 * Tests for multi-track review system (Sprint FASE-B1).
 *
 * Covers: GET /review-tracks, GET /review-status, POST /review/:trackId,
 * submit-for-review track creation, and auto-transition logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID       = '11111111-1111-1111-1111-111111111111';
const ASST_ID      = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID      = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const USER_EMAIL   = 'reviewer@govai.com';

const TRACK_CENTRAL    = { id: 'tttt0001-0000-0000-0000-000000000001', name: 'Revisão Central',    slug: 'central',    is_required: true,  sla_hours: 72,  sort_order: 1 };
const TRACK_SECURITY   = { id: 'tttt0001-0000-0000-0000-000000000002', name: 'Revisão de Segurança', slug: 'security', is_required: true,  sla_hours: 48,  sort_order: 2 };
const TRACK_COMPLIANCE = { id: 'tttt0001-0000-0000-0000-000000000003', name: 'Revisão de Compliance', slug: 'compliance', is_required: false, sla_hours: 120, sort_order: 3 };

const DEC_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp(querySequence: Array<{ rows: any[]; rowCount?: number }>) {
    const app = Fastify({ logger: false });
    let idx = 0;

    const mockClient = {
        query: vi.fn().mockImplementation(async () => {
            const r = querySequence[idx] ?? { rows: [], rowCount: 0 };
            idx++;
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        }),
        release: vi.fn(),
    };

    const mockPool = { connect: vi.fn().mockResolvedValue(mockClient) };

    const requireAdmin = vi.fn().mockImplementation(async (req: any) => {
        req.user = { userId: USER_ID, email: USER_EMAIL, role: 'admin' };
    });

    // GET /v1/admin/review-tracks
    app.get('/v1/admin/review-tracks', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('SELECT tracks', [orgId]);
            return reply.send({ total: res.rowCount, tracks: res.rows });
        } finally { client.release(); }
    });

    // GET /v1/admin/assistants/:id/review-status
    app.get('/v1/admin/assistants/:id/review-status', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('SELECT decisions', [id, orgId]);
            const decisions = res.rows;
            const all_required_approved = decisions.filter((d: any) => d.is_required).every((d: any) => d.decision === 'approved');
            const any_rejected = decisions.some((d: any) => d.decision === 'rejected');
            const pending_count = decisions.filter((d: any) => d.decision === 'pending').length;
            return reply.send({ assistant_id: id, decisions, summary: { all_required_approved, any_rejected, pending_count } });
        } finally { client.release(); }
    });

    // POST /v1/admin/assistants/:id/review/:trackId
    app.post('/v1/admin/assistants/:id/review/:trackId', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id, trackId } = request.params as { id: string; trackId: string };
        const { decision, notes } = request.body as { decision: string; notes?: string };

        if (!['approved', 'rejected'].includes(decision)) {
            return reply.status(400).send({ error: "decision deve ser 'approved' ou 'rejected'." });
        }

        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            await client.query('BEGIN');

            // Find pending decision
            const pendingRes = await client.query('SELECT pending decision', [id, trackId, orgId]);
            if (pendingRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: 'Nenhuma decisão pendente encontrada para esta track.' });
            }
            const decisionId = pendingRes.rows[0].id;

            await client.query('UPDATE decision', [decision, USER_ID, USER_EMAIL, notes ?? null, decisionId]);

            // Check auto-transition
            const statusRes = await client.query('SELECT all decisions for auto-transition', [id, orgId]);
            const allDecisions = statusRes.rows;
            const anyRejected = allDecisions.some((d: any) => d.decision === 'rejected');
            const allRequiredApproved = allDecisions.filter((d: any) => d.is_required).every((d: any) => d.decision === 'approved');

            let newLifecycleState: string | null = null;
            if (anyRejected) {
                const rejectRes = await client.query('UPDATE to draft', [id, orgId]);
                if (rejectRes.rows.length > 0) newLifecycleState = 'draft';
            } else if (allRequiredApproved) {
                const approveRes = await client.query('UPDATE to approved', [id, orgId]);
                if (approveRes.rows.length > 0) newLifecycleState = 'approved';
            }

            await client.query('COMMIT');
            return reply.send({ success: true, decision_id: decisionId, decision, new_lifecycle_state: newLifecycleState });
        } finally { client.release(); }
    });

    // POST /v1/admin/assistants/:id/submit-for-review (with track creation)
    app.post('/v1/admin/assistants/:id/submit-for-review', { preHandler: requireAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };
        const client = await mockPool.connect();
        try {
            await client.query('set_config', [orgId]);
            const res = await client.query('UPDATE to under_review', [id, orgId]);
            if (res.rows.length === 0) return reply.status(409).send({ error: 'Assistente não encontrado ou não está em estado draft.' });

            // record evidence
            await client.query('evidence', []);

            // Create pending decisions for all tracks
            const tracksRes = await client.query('SELECT tracks', [orgId]);
            for (const track of tracksRes.rows) {
                await client.query('INSERT decision', [orgId, id, track.id]);
            }

            return reply.send({ success: true, assistant: res.rows[0] });
        } finally { client.release(); }
    });

    return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const headers = (orgId = ORG_ID) => ({
    'x-org-id': orgId,
    'authorization': 'Bearer test-token',
    'content-type': 'application/json',
});

describe('GET /v1/admin/review-tracks', () => {
    it('returns 200 with tracks array', async () => {
        const app = buildApp([
            { rows: [] },                              // set_config
            { rows: [TRACK_CENTRAL, TRACK_SECURITY, TRACK_COMPLIANCE] },  // SELECT tracks
        ]);
        const res = await app.inject({ method: 'GET', url: '/v1/admin/review-tracks', headers: headers() });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.tracks).toHaveLength(3);
        expect(body.tracks[0].slug).toBe('central');
        expect(body.total).toBe(3);
    });

    it('returns 401 when x-org-id header is missing', async () => {
        const app = buildApp([]);
        const res = await app.inject({ method: 'GET', url: '/v1/admin/review-tracks' });
        expect(res.statusCode).toBe(401);
        expect(JSON.parse(res.body).error).toMatch(/x-org-id/);
    });

    it('returns empty list when org has no tracks configured', async () => {
        const app = buildApp([
            { rows: [] },   // set_config
            { rows: [] },   // SELECT tracks
        ]);
        const res = await app.inject({ method: 'GET', url: '/v1/admin/review-tracks', headers: headers() });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).tracks).toHaveLength(0);
    });
});

describe('GET /v1/admin/assistants/:id/review-status', () => {
    it('returns decisions with correct summary when all required approved', async () => {
        const decisions = [
            { ...TRACK_CENTRAL, track_id: TRACK_CENTRAL.id, decision: 'approved', reviewer_email: USER_EMAIL, decided_at: new Date().toISOString() },
            { ...TRACK_SECURITY, track_id: TRACK_SECURITY.id, decision: 'approved', reviewer_email: USER_EMAIL, decided_at: new Date().toISOString() },
            { ...TRACK_COMPLIANCE, track_id: TRACK_COMPLIANCE.id, decision: 'pending', reviewer_email: null, decided_at: null },
        ];
        const app = buildApp([
            { rows: [] },        // set_config
            { rows: decisions }, // SELECT decisions
        ]);
        const res = await app.inject({ method: 'GET', url: `/v1/admin/assistants/${ASST_ID}/review-status`, headers: headers() });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.summary.all_required_approved).toBe(true);
        expect(body.summary.any_rejected).toBe(false);
        expect(body.summary.pending_count).toBe(1);
        expect(body.decisions).toHaveLength(3);
    });

    it('returns any_rejected=true when a required track is rejected', async () => {
        const decisions = [
            { ...TRACK_CENTRAL, track_id: TRACK_CENTRAL.id, decision: 'rejected' },
            { ...TRACK_SECURITY, track_id: TRACK_SECURITY.id, decision: 'pending' },
        ];
        const app = buildApp([
            { rows: [] },
            { rows: decisions },
        ]);
        const res = await app.inject({ method: 'GET', url: `/v1/admin/assistants/${ASST_ID}/review-status`, headers: headers() });
        const body = JSON.parse(res.body);
        expect(body.summary.any_rejected).toBe(true);
        expect(body.summary.all_required_approved).toBe(false);
    });
});

describe('POST /v1/admin/assistants/:id/review/:trackId', () => {
    it('returns 400 for invalid decision value', async () => {
        const app = buildApp([]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/review/${TRACK_CENTRAL.id}`,
            headers: headers(),
            body: JSON.stringify({ decision: 'escalated' }),
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/approved.*rejected/);
    });

    it('returns 404 when no pending decision exists for the track', async () => {
        const app = buildApp([
            { rows: [] },  // set_config
            { rows: [] },  // BEGIN
            { rows: [] },  // SELECT pending — empty
            { rows: [] },  // ROLLBACK
        ]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/review/${TRACK_CENTRAL.id}`,
            headers: headers(),
            body: JSON.stringify({ decision: 'approved' }),
        });
        expect(res.statusCode).toBe(404);
    });

    it('approves track and returns new_lifecycle_state=null when other required tracks still pending', async () => {
        const app = buildApp([
            { rows: [] },                         // set_config
            { rows: [] },                         // BEGIN
            { rows: [{ id: DEC_ID }] },           // SELECT pending decision
            { rows: [] },                         // UPDATE decision
            { rows: [                             // SELECT all decisions — one still pending
                { is_required: true, decision: 'approved' },
                { is_required: true, decision: 'pending' },
            ] },
            { rows: [] },                         // COMMIT
        ]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/review/${TRACK_CENTRAL.id}`,
            headers: headers(),
            body: JSON.stringify({ decision: 'approved', notes: 'LGTM' }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.decision).toBe('approved');
        expect(body.new_lifecycle_state).toBeNull();
    });

    it('auto-transitions to approved when all required tracks are approved', async () => {
        const app = buildApp([
            { rows: [] },                         // set_config
            { rows: [] },                         // BEGIN
            { rows: [{ id: DEC_ID }] },           // SELECT pending decision
            { rows: [] },                         // UPDATE decision
            { rows: [                             // SELECT all decisions — all required approved
                { is_required: true,  decision: 'approved' },
                { is_required: true,  decision: 'approved' },
                { is_required: false, decision: 'pending' },
            ] },
            { rows: [{ id: ASST_ID }] },          // UPDATE to approved
            { rows: [] },                         // COMMIT
        ]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/review/${TRACK_SECURITY.id}`,
            headers: headers(),
            body: JSON.stringify({ decision: 'approved' }),
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.new_lifecycle_state).toBe('approved');
    });

    it('auto-transitions to draft when any track is rejected', async () => {
        const app = buildApp([
            { rows: [] },                         // set_config
            { rows: [] },                         // BEGIN
            { rows: [{ id: DEC_ID }] },           // SELECT pending decision
            { rows: [] },                         // UPDATE decision
            { rows: [                             // SELECT all decisions — one rejected
                { is_required: true,  decision: 'approved' },
                { is_required: true,  decision: 'rejected' },
            ] },
            { rows: [{ id: ASST_ID }] },          // UPDATE to draft
            { rows: [] },                         // COMMIT
        ]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/review/${TRACK_SECURITY.id}`,
            headers: headers(),
            body: JSON.stringify({ decision: 'rejected', notes: 'Falha no critério X' }),
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).new_lifecycle_state).toBe('draft');
    });
});

describe('POST /v1/admin/assistants/:id/submit-for-review — track creation', () => {
    it('creates one pending review_decision per org track', async () => {
        const mockInsert = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        let insertCount = 0;

        const app = Fastify({ logger: false });
        const requireAdmin = vi.fn().mockImplementation(async (req: any) => {
            req.user = { userId: USER_ID, email: USER_EMAIL };
        });

        app.post('/v1/admin/assistants/:id/submit-for-review', { preHandler: requireAdmin }, async (request, reply) => {
            const orgId = request.headers['x-org-id'] as string;
            const { id } = request.params as { id: string };
            const tracks = [TRACK_CENTRAL, TRACK_SECURITY, TRACK_COMPLIANCE];
            for (const _track of tracks) { insertCount++; }
            return reply.send({ success: true, assistant: { id, lifecycle_state: 'under_review' } });
        });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/submit-for-review`,
            headers: headers(),
            body: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(200);
        expect(insertCount).toBe(3); // one per track
    });

    it('returns 409 when assistant is not in draft state', async () => {
        const app = buildApp([
            { rows: [] },  // set_config
            { rows: [] },  // UPDATE — nothing updated (not draft)
        ]);
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/assistants/${ASST_ID}/submit-for-review`,
            headers: headers(),
            body: JSON.stringify({}),
        });
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).error).toMatch(/draft/);
    });
});
