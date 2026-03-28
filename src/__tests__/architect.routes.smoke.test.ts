// AVISO:
// este arquivo testa apenas que as rotas respondem (smoke tests)
// NÃO testa autorização nem banco real.
// Para testes com banco real, ver architect.domain.test.ts

/**
 * Sprint A1: Architect Routes Smoke Tests
 *
 * Registers architectRoutes with mocked domain service functions.
 * Covers happy-path for all 13 endpoints.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { architectRoutes } from '../routes/architect.routes';

// ── Mock lib/architect — all data defined inside the factory (hoisting-safe) ──

vi.mock('../lib/architect', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const CASE_ID     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const CONTRACT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const DECISION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const WORKFLOW_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const WORKITEM_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const ORG_ID      = '11111111-1111-1111-1111-111111111111';

    const mockCase = {
        id: CASE_ID, org_id: ORG_ID, title: 'Test case', description: null,
        source_type: 'internal', source_ref: null, status: 'draft', priority: 'medium',
        requested_by: null, assigned_to: null, due_at: null, closed_at: null,
        closed_reason: null, created_at: now, updated_at: now,
    };
    const mockContract = {
        id: CONTRACT_ID, org_id: ORG_ID, demand_case_id: CASE_ID, version: 1,
        goal: 'Test goal', constraints_json: [], non_goals_json: [],
        acceptance_criteria_json: [], open_questions_json: [], context_snippets_json: [],
        confidence_score: 50, status: 'draft', accepted_by: null, accepted_at: null,
        created_at: now, updated_at: now,
    };
    const mockDecision = {
        id: DECISION_ID, org_id: ORG_ID, problem_contract_id: CONTRACT_ID,
        recommended_option: 'Option A', alternatives_json: [], tradeoffs_json: [],
        risks_json: [], rationale_md: '## Rationale', status: 'draft',
        proposed_by: null, proposed_at: null, approved_by: null, approved_at: null,
        rejection_reason: null, created_at: now, updated_at: now,
    };
    const mockWorkflow = {
        id: WORKFLOW_ID, org_id: ORG_ID, architecture_decision_set_id: DECISION_ID,
        version: 1, graph_json: {}, status: 'delegated',
        compiled_at: now, delegated_at: now, completed_at: null,
        created_at: now, updated_at: now,
    };
    const mockWorkItem = {
        id: WORKITEM_ID, org_id: ORG_ID, workflow_graph_id: WORKFLOW_ID,
        node_id: 'n1', item_type: 'human_task', title: 'Manual task',
        description: null, ref_type: null, ref_id: null, status: 'pending',
        assigned_to: null, due_at: null, completed_at: null,
        result_ref: null, result_notes: null, created_at: now, updated_at: now,
    };
    const mockFull = {
        case: mockCase,
        contract: mockContract,
        decisions: [mockDecision],
        workflow: mockWorkflow,
        workItems: [mockWorkItem],
    };

    return {
        createDemandCase:        vi.fn().mockResolvedValue(mockCase),
        listDemandCases:         vi.fn().mockResolvedValue([mockCase]),
        getDemandCaseFull:       vi.fn().mockResolvedValue(mockFull),
        updateDemandCaseStatus:  vi.fn().mockResolvedValue(undefined),
        upsertProblemContract:   vi.fn().mockResolvedValue(mockContract),
        discoverWithContext:      vi.fn().mockResolvedValue({
            snippets: [{ source: 'kb-1', content: 'Relevant content', score: 0.95 }],
        }),
        acceptProblemContract:   vi.fn().mockResolvedValue(undefined),
        createDecisionSet:       vi.fn().mockResolvedValue(mockDecision),
        proposeDecisionSet:      vi.fn().mockResolvedValue(undefined),
        approveDecisionSet:      vi.fn().mockResolvedValue(undefined),
        rejectDecisionSet:       vi.fn().mockResolvedValue(undefined),
        compileWorkflow:         vi.fn().mockResolvedValue({
            workflow: mockWorkflow,
            workItems: [mockWorkItem],
        }),
        updateWorkItem:          vi.fn().mockResolvedValue({
            ...mockWorkItem, status: 'done', completed_at: now,
        }),
        answerDiscoveryQuestion: vi.fn().mockResolvedValue({
            contract: mockContract,
            confidenceScore: 75,
            readyForAcceptance: true,
        }),
        addDiscoveryQuestion:    vi.fn().mockResolvedValue(mockContract),
        generateArchitectDocument: vi.fn().mockResolvedValue({
            content: '# ADR\n## Decision\nUse Option A',
            evidenceId: 'ev-0001',
        }),
        getDiscoveryStatus:      vi.fn().mockResolvedValue({
            caseStatus: 'discovery',
            contractExists: true,
            contractStatus: 'draft',
            confidenceScore: 50,
            totalQuestions: 2,
            answeredQuestions: 1,
            readyForAcceptance: false,
            hasAcceptanceCriteria: true,
        }),
    };
});

// ── Constants (referenced in tests only — not in vi.mock factory) ─────────────

const CASE_ID     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DECISION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const WORKITEM_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ORG_ID      = '11111111-1111-1111-1111-111111111111';

// ── Test setup ────────────────────────────────────────────────────────────────

const requireRole = (_roles: string[]) => async (req: any, _reply: any) => {
    req.user = { email: 'admin@test.com', userId: 'user-001', orgId: ORG_ID, role: 'admin' };
};

function makeMockPool() {
    const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
            if (sql.includes('set_config')) return { rows: [] };
            if (sql.includes('FROM problem_contracts')) {
                return { rows: [{ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] };
            }
            return { rows: [], rowCount: 0 };
        }),
        release: vi.fn(),
    };
    return {
        connect: vi.fn().mockResolvedValue(mockClient),
        query:   vi.fn().mockResolvedValue({ rows: [] }),
    } as any;
}

let app: FastifyInstance;

beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(architectRoutes, {
        pgPool: makeMockPool(),
        requireRole,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

const JSON_H = { 'Content-Type': 'application/json' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Architect Routes — Smoke Tests', () => {

    it('POST /v1/admin/architect/cases → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/architect/cases',
            headers: JSON_H,
            payload: { title: 'New case', source_type: 'internal' },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(CASE_ID);
        expect(body.status).toBe('draft');
    });

    it('GET /v1/admin/architect/cases → 200 with cases array', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/admin/architect/cases',
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.cases)).toBe(true);
        expect(body.cases).toHaveLength(1);
        expect(typeof body.total).toBe('number');
    });

    it('GET /v1/admin/architect/cases/:id → 200 with DemandCaseFull shape', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/v1/admin/architect/cases/${CASE_ID}`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.case.id).toBe(CASE_ID);
        expect(body.contract).not.toBeNull();
        expect(Array.isArray(body.decisions)).toBe(true);
        expect(body.workflow).not.toBeNull();
        expect(Array.isArray(body.workItems)).toBe(true);
    });

    it('PATCH /v1/admin/architect/cases/:id/status → 200', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/v1/admin/architect/cases/${CASE_ID}/status`,
            headers: JSON_H,
            payload: { status: 'intake' },
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('POST /v1/admin/architect/cases/:id/contract → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/contract`,
            headers: JSON_H,
            payload: {
                goal: 'Ensure compliance',
                constraints_json: [],
                non_goals_json: [],
                acceptance_criteria_json: [],
                open_questions_json: [],
            },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.goal).toBe('Test goal');
    });

    it('POST /v1/admin/architect/cases/:id/discover → 200 with snippets array', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover`,
            headers: JSON_H,
            payload: { question: 'What are the GDPR risks?' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.snippets)).toBe(true);
        expect(body.snippets[0].score).toBeGreaterThan(0);
    });

    it('POST /v1/admin/architect/cases/:id/contract/accept → 200', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/contract/accept`,
            headers: JSON_H,
            payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('POST /v1/admin/architect/cases/:id/decisions → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/decisions`,
            headers: JSON_H,
            payload: {
                recommended_option: 'Option A',
                alternatives_json: [],
                tradeoffs_json: [],
                risks_json: [],
                rationale_md: '## Rationale',
            },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(DECISION_ID);
    });

    it('POST /v1/admin/architect/decisions/:id/propose → 200', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/propose`,
            headers: JSON_H,
            payload: {},
        });
        expect(res.statusCode).toBe(200);
    });

    it('POST /v1/admin/architect/decisions/:id/approve → 200', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/approve`,
            headers: JSON_H,
            payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('POST /v1/admin/architect/decisions/:id/reject → 200', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/reject`,
            headers: JSON_H,
            payload: { reason: 'Not feasible' },
        });
        expect(res.statusCode).toBe(200);
    });

    it('POST /v1/admin/architect/decisions/:id/compile → 201', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/compile`,
            headers: JSON_H,
            payload: {
                graph_json: {
                    nodes: [{ id: 'n1', type: 'human_task', label: 'Task 1' }],
                    edges: [],
                    metadata: { estimated_effort_hours: 4, domains_involved: [] },
                },
            },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.workItems)).toBe(true);
    });

    it('GET /v1/admin/architect/cases/:id/work-items → 200', async () => {
        const res = await app.inject({
            method: 'GET',
            url: `/v1/admin/architect/cases/${CASE_ID}/work-items`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(Array.isArray(body.workItems)).toBe(true);
    });

    it('PATCH /v1/admin/architect/work-items/:id → 200', async () => {
        const res = await app.inject({
            method: 'PATCH',
            url: `/v1/admin/architect/work-items/${WORKITEM_ID}`,
            headers: JSON_H,
            payload: { status: 'done', result_notes: 'Completed' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.status).toBe('done');
    });

    it('POST /cases with missing required fields → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/architect/cases',
            headers: JSON_H,
            payload: { title: 'Missing source_type' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /decisions/:id/compile with empty nodes → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/compile`,
            headers: JSON_H,
            payload: {
                graph_json: { nodes: [], metadata: {} },
            },
        });
        expect(res.statusCode).toBe(400);
    });

    it('GET /cases/:id → 404 when getDemandCaseFull returns null', async () => {
        const { getDemandCaseFull } = await import('../lib/architect');
        vi.mocked(getDemandCaseFull).mockResolvedValueOnce(null);

        const res = await app.inject({
            method: 'GET',
            url: `/v1/admin/architect/cases/00000000-0000-0000-0000-000000000000`,
        });
        expect(res.statusCode).toBe(404);
    });
});

// ── Sprint A2 smoke tests ─────────────────────────────────────────────────────

describe('Architect Routes — Sprint A2 Smoke Tests', () => {

    it('POST /cases/:id/discover/answer → 200 with contract and confidenceScore', async () => {
        const { answerDiscoveryQuestion } = await import('../lib/architect');
        vi.mocked(answerDiscoveryQuestion).mockResolvedValueOnce({
            contract: {
                id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                org_id: ORG_ID,
                demand_case_id: CASE_ID,
                version: 1,
                goal: 'Test goal',
                constraints_json: [],
                non_goals_json: [],
                acceptance_criteria_json: [],
                open_questions_json: [],
                context_snippets_json: [],
                confidence_score: 75,
                status: 'draft',
                accepted_by: null,
                accepted_at: null,
                created_at: new Date('2026-01-01T00:00:00Z'),
                updated_at: new Date('2026-01-01T00:00:00Z'),
            },
            confidenceScore: 75,
            readyForAcceptance: true,
        });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover/answer`,
            headers: JSON_H,
            payload: { questionIndex: 0, answer: 'Customer data' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.confidenceScore).toBe(75);
        expect(body.readyForAcceptance).toBe(true);
    });

    it('POST /cases/:id/discover/questions → 201 with updated contract', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover/questions`,
            headers: JSON_H,
            payload: { question: 'What is the data source?' },
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(body.goal).toBe('Test goal');
    });

    it('GET /cases/:id/discover/status → 200 with discovery summary', async () => {
        const { getDiscoveryStatus } = await import('../lib/architect');
        vi.mocked(getDiscoveryStatus).mockResolvedValueOnce({
            caseStatus: 'discovery',
            contractExists: true,
            contractStatus: 'draft',
            confidenceScore: 50,
            totalQuestions: 2,
            answeredQuestions: 1,
            readyForAcceptance: false,
            hasAcceptanceCriteria: true,
        });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover/status`,
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.contractExists).toBe(true);
        expect(body.confidenceScore).toBe(50);
        expect(typeof body.totalQuestions).toBe('number');
    });

    it('POST /decisions/:id/document → 201 with content and evidenceId', async () => {
        const { generateArchitectDocument } = await import('../lib/architect');
        vi.mocked(generateArchitectDocument).mockResolvedValueOnce({
            content: '# ADR\n## Decision\nUse Option A',
            evidenceId: 'ev-0001',
        });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/decisions/${DECISION_ID}/document`,
            headers: JSON_H,
            payload: {},
        });
        expect(res.statusCode).toBe(201);
        const body = JSON.parse(res.body);
        expect(typeof body.content).toBe('string');
        expect(body.content.length).toBeGreaterThan(0);
        expect(typeof body.evidenceId).toBe('string');
    });

    it('POST /cases/:id/discover/answer with missing fields → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover/answer`,
            headers: JSON_H,
            payload: { questionIndex: 0 }, // missing answer
        });
        expect(res.statusCode).toBe(400);
    });

    it('POST /cases/:id/discover/questions with missing question → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: `/v1/admin/architect/cases/${CASE_ID}/discover/questions`,
            headers: JSON_H,
            payload: {},
        });
        expect(res.statusCode).toBe(400);
    });
});
