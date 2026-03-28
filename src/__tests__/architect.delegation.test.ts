/**
 * Sprint A4: Architect Delegation Router — Integration Tests
 *
 * Requires DATABASE_URL (excluded from default vitest run without it).
 * Tests T1–T8 cover all adapters, routing, terminal state guards, and batch dispatch.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import {
    runInternalRagAdapter,
    runHumanAdapter,
    dispatchWorkItem,
    dispatchPendingWorkItems,
} from '../lib/architect-delegation';

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock('../lib/rag', () => ({
    searchSimilarChunks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/evidence', () => ({
    recordEvidence: vi.fn().mockResolvedValue(undefined),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG_ID       = '11111111-1111-1111-1111-111111111111';
const WORKFLOW_ID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ── DB helpers ────────────────────────────────────────────────────────────────

let pool: Pool;

beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
});

afterAll(async () => {
    await pool.end();
});

async function createOrg(): Promise<string> {
    const res = await pool.query(
        `INSERT INTO organizations (id, name, slug, plan)
         VALUES ($1, 'Delegation Test Org', 'delegation-test-org', 'enterprise')
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [ORG_ID]
    );
    return res.rows[0]?.id ?? ORG_ID;
}

async function createCase(orgId: string): Promise<string> {
    const res = await pool.query(
        `INSERT INTO architect_demand_cases
             (org_id, title, source_type, status, priority)
         VALUES ($1, 'Delegation Test Case', 'internal', 'design', 'medium')
         RETURNING id`,
        [orgId]
    );
    return res.rows[0].id;
}

async function createWorkflow(orgId: string, decisionId: string): Promise<string> {
    const res = await pool.query(
        `INSERT INTO architect_workflow_graphs
             (org_id, architecture_decision_set_id, version, graph_json, status)
         VALUES ($1, $2, 1, '{}', 'delegated')
         RETURNING id`,
        [orgId, decisionId]
    );
    return res.rows[0].id;
}

async function createDecision(orgId: string, caseId: string): Promise<string> {
    // Requires a problem_contract first
    const contractRes = await pool.query(
        `INSERT INTO problem_contracts
             (org_id, demand_case_id, version, goal, confidence_score, status)
         VALUES ($1, $2, 1, 'Test goal', 50, 'accepted')
         RETURNING id`,
        [orgId, caseId]
    );
    const contractId = contractRes.rows[0].id;

    const decRes = await pool.query(
        `INSERT INTO architect_decision_sets
             (org_id, problem_contract_id, recommended_option, rationale_md, status)
         VALUES ($1, $2, 'Option A', '## Rationale', 'approved')
         RETURNING id`,
        [orgId, contractId]
    );
    return decRes.rows[0].id;
}

async function createWorkItem(
    orgId: string,
    workflowId: string,
    hint: string | null = null,
    status = 'pending'
): Promise<string> {
    const res = await pool.query(
        `INSERT INTO architect_work_items
             (org_id, workflow_graph_id, node_id, item_type, title, status, execution_hint)
         VALUES ($1, $2, 'n1', 'human_task', 'Test task', $3, $4)
         RETURNING id`,
        [orgId, workflowId, status, hint]
    );
    return res.rows[0].id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Architect Delegation Router — Integration Tests', () => {

    // T1: internal_rag with no KB → success=true, snippets=[]
    it('T1: runInternalRagAdapter with no KB returns success=true and empty snippets', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'internal_rag');

        const result = await runInternalRagAdapter(pool, ORG_ID, itemId);

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
        const snippets = (result.output as { snippets?: unknown[] }).snippets ?? [];
        expect(Array.isArray(snippets)).toBe(true);
    });

    // T2: human adapter → success=true, message='Human action required'
    it('T2: runHumanAdapter returns success=true with human action message', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'human');

        const result = await runHumanAdapter(pool, ORG_ID, itemId);

        expect(result.success).toBe(true);
        expect((result.output as { message: string }).message).toBe('Human action required');
    });

    // T3: dispatch with null execution_hint → human adapter, success=true
    it('T3: dispatchWorkItem with null execution_hint routes to human adapter', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, null);

        const result = await dispatchWorkItem(pool, ORG_ID, itemId);

        expect(result.success).toBe(true);
        expect(result.adapter).toBe('human');
    });

    // T4: dispatch on 'done' item → throws 'already terminal'
    it('T4: dispatchWorkItem on done item throws "already terminal"', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'human', 'done');

        await expect(dispatchWorkItem(pool, ORG_ID, itemId))
            .rejects.toThrow('already terminal');
    });

    // T5: dispatch_attempts >= 3 → throws 'Max dispatch attempts'
    it('T5: dispatchWorkItem with dispatch_attempts=3 throws "Max dispatch attempts"', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'human');

        // Set attempts to 3
        await pool.query(
            `UPDATE architect_work_items SET dispatch_attempts = 3 WHERE id = $1`,
            [itemId]
        );

        await expect(dispatchWorkItem(pool, ORG_ID, itemId))
            .rejects.toThrow('Max dispatch attempts');
    });

    // T6: runInternalRagAdapter with wrong execution_hint → success=false, 'Wrong adapter'
    it('T6: runInternalRagAdapter with wrong execution_hint returns success=false', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'human');

        const result = await runInternalRagAdapter(pool, ORG_ID, itemId);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Wrong adapter');
    });

    // T7: dispatchPendingWorkItems with 2 pending → array of 2 results
    it('T7: dispatchPendingWorkItems dispatches all pending items and returns results array', async () => {
        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);

        const itemId1 = await createWorkItem(ORG_ID, workflowId, 'human');
        const itemId2 = await createWorkItem(ORG_ID, workflowId, 'human');

        // Override workflow_graph_id match for batch
        await pool.query(
            `UPDATE architect_work_items SET workflow_graph_id = $1 WHERE id = ANY($2::uuid[])`,
            [workflowId, [itemId1, itemId2]]
        );

        const results = await dispatchPendingWorkItems(pool, ORG_ID, workflowId);

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThanOrEqual(2);
        expect(results.every(r => r.workItemId)).toBe(true);
    });

    // T8: After dispatch, status is updated in DB
    it('T8: After dispatchWorkItem with internal_rag, execution_context is persisted in DB', async () => {
        const { searchSimilarChunks } = await import('../lib/rag');
        vi.mocked(searchSimilarChunks).mockResolvedValueOnce([
            { content: 'Relevant snippet', similarity: 0.9 },
        ]);

        await createOrg();
        const caseId     = await createCase(ORG_ID);
        const decisionId = await createDecision(ORG_ID, caseId);
        const workflowId = await createWorkflow(ORG_ID, decisionId);
        const itemId     = await createWorkItem(ORG_ID, workflowId, 'internal_rag');

        // Create a KB so the adapter finds it
        await pool.query(
            `INSERT INTO knowledge_bases (org_id, name, description)
             VALUES ($1, 'Delegation Test KB', 'test')
             ON CONFLICT DO NOTHING`,
            [ORG_ID]
        );

        await dispatchWorkItem(pool, ORG_ID, itemId);

        const res = await pool.query(
            `SELECT status, execution_context FROM architect_work_items WHERE id = $1`,
            [itemId]
        );
        expect(res.rows[0].status).toBe('done');
        expect(res.rows[0].execution_context).toBeTruthy();
        expect(res.rows[0].execution_context.adapter).toBe('internal_rag');
    });
});
