/**
 * architect.domain.test.ts — Sprint A1
 *
 * INTEGRATION: requires DATABASE_URL
 * Excluded from standard suite via integrationTestPatterns in vitest.config.ts.
 *
 * Tests the full Architect domain service against a real PostgreSQL database.
 * All tests are isolated by org_id and cleaned up in afterAll.
 */

// INTEGRATION: requires DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    throw new Error(
        'architect.domain.test.ts requer DATABASE_URL. ' +
        'Excluído automaticamente via integrationTestPatterns.'
    );
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
    createDemandCase,
    updateDemandCaseStatus,
    upsertProblemContract,
    acceptProblemContract,
    createDecisionSet,
    approveDecisionSet,
    rejectDecisionSet,
    compileWorkflow,
    updateWorkItem,
    listDemandCases,
    getDemandCaseFull,
    discoverWithContext,
} from '../lib/architect';

const pool = new Pool({ connectionString: DATABASE_URL });

const ORG_ID   = '00000000-0000-0000-0000-000000000001';
const ACTOR_ID = '55d9bd9f-f9c9-4d78-9aa0-3b3af2e4f7ab'; // admin@orga.com

// Track created IDs for cleanup
const createdCaseIds: string[] = [];

async function setOrg() {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
    } finally {
        client.release();
    }
}

beforeAll(async () => {
    await setOrg();
});

afterAll(async () => {
    // Clean up in reverse-dependency order
    if (createdCaseIds.length > 0) {
        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            for (const id of createdCaseIds) {
                // Cascades to contracts, decisions, workflows, work items
                await client.query(
                    'DELETE FROM demand_cases WHERE id = $1 AND org_id = $2',
                    [id, ORG_ID]
                ).catch(() => {});
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    }
    await pool.end();
});

// ── T1: createDemandCase ──────────────────────────────────────────────────────

describe('T1: createDemandCase', () => {
    it('returns row with status=draft, correct org_id', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T1',
            source_type: 'internal',
            priority: 'medium',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        expect(c.status).toBe('draft');
        expect(c.org_id).toBe(ORG_ID);
        expect(c.title).toBe('Test case T1');
        expect(c.priority).toBe('medium');
    });
});

// ── T2: updateDemandCaseStatus draft→intake ───────────────────────────────────

describe('T2: updateDemandCaseStatus valid transition', () => {
    it('draft→intake succeeds', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T2',
            source_type: 'client_request',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        await updateDemandCaseStatus(pool, ORG_ID, c.id, 'intake', ACTOR_ID);

        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const res = await client.query(
                'SELECT status FROM demand_cases WHERE id = $1', [c.id]
            );
            expect(res.rows[0].status).toBe('intake');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T3: updateDemandCaseStatus invalid transition ─────────────────────────────

describe('T3: updateDemandCaseStatus invalid transition', () => {
    it('draft→decision throws with Invalid transition message', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T3',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        await expect(
            updateDemandCaseStatus(pool, ORG_ID, c.id, 'decision', ACTOR_ID)
        ).rejects.toThrow(/Invalid transition/);
    });
});

// ── T4: upsertProblemContract on new case ─────────────────────────────────────

describe('T4: upsertProblemContract creates contract and advances case', () => {
    it('inserts contract, case advances to contracting', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T4',
            source_type: 'compliance_requirement',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Ensure GDPR compliance',
            constraints_json: [{ constraint: 'Budget < 50k', rationale: 'ops' }],
            non_goals_json: ['Rebuild legacy system'],
            acceptance_criteria_json: [{ criterion: 'Zero PII leaks', measurable: true }],
            open_questions_json: [],
        });

        expect(contract.goal).toBe('Ensure GDPR compliance');
        expect(contract.demand_case_id).toBe(c.id);
        expect(contract.status).toBe('draft');
        expect(contract.version).toBe(1);

        // Case should have advanced to contracting
        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const res = await client.query(
                'SELECT status FROM demand_cases WHERE id = $1', [c.id]
            );
            expect(res.rows[0].status).toBe('contracting');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T5: upsertProblemContract on accepted contract ────────────────────────────

describe('T5: upsertProblemContract on accepted contract throws', () => {
    it('throws immutability error', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T5',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T5',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });

        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        await expect(
            upsertProblemContract(pool, ORG_ID, c.id, {
                goal: 'Modified goal',
                constraints_json: [],
                non_goals_json: [],
                acceptance_criteria_json: [],
                open_questions_json: [],
            })
        ).rejects.toThrow(/immutable after acceptance/);
    });
});

// ── T6: acceptProblemContract ─────────────────────────────────────────────────

describe('T6: acceptProblemContract', () => {
    it('sets status=accepted and advances case to decision', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T6',
            source_type: 'catalog_gap',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T6',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });

        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const cRes = await client.query(
                'SELECT status FROM demand_cases WHERE id = $1', [c.id]
            );
            const pcRes = await client.query(
                'SELECT status, accepted_by FROM problem_contracts WHERE id = $1',
                [contract.id]
            );
            expect(pcRes.rows[0].status).toBe('accepted');
            expect(pcRes.rows[0].accepted_by).toBe(ACTOR_ID);
            expect(cRes.rows[0].status).toBe('decision');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T7: createDecisionSet ─────────────────────────────────────────────────────

describe('T7: createDecisionSet', () => {
    it('creates decision set with status=draft linked to contract', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T7',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T7',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option A',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## Rationale\nOption A is best.',
        }, ACTOR_ID);

        expect(decision.status).toBe('draft');
        expect(decision.problem_contract_id).toBe(contract.id);
        expect(decision.recommended_option).toBe('Option A');
    });
});

// ── T8: approveDecisionSet ────────────────────────────────────────────────────

describe('T8: approveDecisionSet', () => {
    it('sets status=approved and advances case to compiling', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T8',
            source_type: 'shield_finding',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T8',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option B',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## Rationale',
        }, ACTOR_ID);

        await approveDecisionSet(pool, ORG_ID, decision.id, ACTOR_ID);

        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const dRes = await client.query(
                'SELECT status, approved_by FROM architecture_decision_sets WHERE id = $1',
                [decision.id]
            );
            const cRes = await client.query(
                'SELECT status FROM demand_cases WHERE id = $1', [c.id]
            );
            expect(dRes.rows[0].status).toBe('approved');
            expect(dRes.rows[0].approved_by).toBe(ACTOR_ID);
            expect(cRes.rows[0].status).toBe('compiling');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T9: rejectDecisionSet ─────────────────────────────────────────────────────

describe('T9: rejectDecisionSet', () => {
    it('sets rejection_reason and status=rejected', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T9',
            source_type: 'client_request',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T9',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option C',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## Rationale',
        }, ACTOR_ID);

        await rejectDecisionSet(pool, ORG_ID, decision.id, ACTOR_ID, 'Not feasible');

        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const res = await client.query(
                'SELECT status, rejection_reason FROM architecture_decision_sets WHERE id = $1',
                [decision.id]
            );
            expect(res.rows[0].status).toBe('rejected');
            expect(res.rows[0].rejection_reason).toBe('Not feasible');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T10: compileWorkflow ──────────────────────────────────────────────────────

describe('T10: compileWorkflow', () => {
    it('creates workflow + 2 work items and advances case to delegated', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T10',
            source_type: 'compliance_requirement',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T10',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option D',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## Rationale',
        }, ACTOR_ID);
        await approveDecisionSet(pool, ORG_ID, decision.id, ACTOR_ID);

        const graphJson = {
            nodes: [
                { id: 'n1', type: 'shield_review',  label: 'Review Shield Finding',  config: { description: 'Review the finding' } },
                { id: 'n2', type: 'catalog_review', label: 'Catalog Promotion Check', config: { description: 'Promote agent' } },
                { id: 'n3', type: 'invalid_type',   label: 'Should be skipped' }, // not a valid item_type
            ],
            edges: [{ from: 'n1', to: 'n2', condition: 'success' }],
            metadata: { estimated_effort_hours: 8, domains_involved: ['shield', 'catalog'] },
        };

        const { workflow, workItems } = await compileWorkflow(
            pool, ORG_ID, decision.id, graphJson, ACTOR_ID
        );

        expect(workflow.status).toBe('delegated');
        expect(workItems).toHaveLength(2); // n3 is skipped
        expect(workItems[0].node_id).toBe('n1');
        expect(workItems[0].item_type).toBe('shield_review');
        expect(workItems[1].node_id).toBe('n2');

        const client = await pool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [ORG_ID]);
            const cRes = await client.query(
                'SELECT status FROM demand_cases WHERE id = $1', [c.id]
            );
            expect(cRes.rows[0].status).toBe('delegated');
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });
});

// ── T11: getDemandCaseFull ────────────────────────────────────────────────────

describe('T11: getDemandCaseFull', () => {
    it('returns nested structure with all related entities', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T11',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T11',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);

        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option E',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## Rationale T11',
        }, ACTOR_ID);
        await approveDecisionSet(pool, ORG_ID, decision.id, ACTOR_ID);

        await compileWorkflow(pool, ORG_ID, decision.id, {
            nodes: [{ id: 'n1', type: 'human_task', label: 'Manual task' }],
            edges: [],
            metadata: {},
        }, ACTOR_ID);

        const full = await getDemandCaseFull(pool, ORG_ID, c.id);

        expect(full).not.toBeNull();
        expect(full!.case.id).toBe(c.id);
        expect(full!.contract).not.toBeNull();
        expect(full!.contract!.id).toBe(contract.id);
        expect(full!.decisions).toHaveLength(1);
        expect(full!.decisions[0].id).toBe(decision.id);
        expect(full!.workflow).not.toBeNull();
        expect(full!.workItems).toHaveLength(1);
    });

    it('returns null for non-existent case', async () => {
        const result = await getDemandCaseFull(
            pool, ORG_ID, '00000000-dead-beef-dead-000000000000'
        );
        expect(result).toBeNull();
    });
});

// ── T12: listDemandCases with status filter ───────────────────────────────────

describe('T12: listDemandCases with status filter', () => {
    it('returns only cases matching the status filter', async () => {
        const c1 = await createDemandCase(pool, ORG_ID, {
            title: 'T12 draft case',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c1.id);

        const c2 = await createDemandCase(pool, ORG_ID, {
            title: 'T12 intake case',
            source_type: 'client_request',
        }, ACTOR_ID);
        createdCaseIds.push(c2.id);
        await updateDemandCaseStatus(pool, ORG_ID, c2.id, 'intake', ACTOR_ID);

        const drafts = await listDemandCases(pool, ORG_ID, { status: 'draft' });
        const intakes = await listDemandCases(pool, ORG_ID, { status: 'intake' });

        const draftIds = drafts.map(d => d.id);
        const intakeIds = intakes.map(d => d.id);

        expect(draftIds).toContain(c1.id);
        expect(draftIds).not.toContain(c2.id);
        expect(intakeIds).toContain(c2.id);
        expect(intakeIds).not.toContain(c1.id);
    });
});

// ── T13: updateWorkItem ───────────────────────────────────────────────────────

describe('T13: updateWorkItem', () => {
    it('updates status, sets completed_at when done', async () => {
        const c = await createDemandCase(pool, ORG_ID, {
            title: 'Test case T13',
            source_type: 'internal',
        }, ACTOR_ID);
        createdCaseIds.push(c.id);

        const contract = await upsertProblemContract(pool, ORG_ID, c.id, {
            goal: 'Goal T13',
            constraints_json: [],
            non_goals_json: [],
            acceptance_criteria_json: [],
            open_questions_json: [],
        });
        await acceptProblemContract(pool, ORG_ID, contract.id, ACTOR_ID);
        const decision = await createDecisionSet(pool, ORG_ID, contract.id, {
            recommended_option: 'Option F',
            alternatives_json: [],
            tradeoffs_json: [],
            risks_json: [],
            rationale_md: '## T13',
        }, ACTOR_ID);
        await approveDecisionSet(pool, ORG_ID, decision.id, ACTOR_ID);
        const { workItems } = await compileWorkflow(pool, ORG_ID, decision.id, {
            nodes: [{ id: 'wi1', type: 'rag_research', label: 'Research task' }],
            edges: [],
            metadata: {},
        }, ACTOR_ID);

        const updated = await updateWorkItem(
            pool, ORG_ID, workItems[0].id,
            { status: 'done', result_notes: 'Research complete' },
            ACTOR_ID
        );

        expect(updated.status).toBe('done');
        expect(updated.result_notes).toBe('Research complete');
        expect(updated.completed_at).not.toBeNull();
    });
});

// ── T14: discoverWithContext with no knowledge base ───────────────────────────

describe('T14: discoverWithContext with no KB', () => {
    it('returns empty snippets without throwing when no knowledge base exists', async () => {
        // Use a fake org that has no knowledge base
        const fakeOrgClient = await pool.connect();
        let fakeOrgId: string | null = null;
        try {
            // Check if there's an org with no KB
            const res = await fakeOrgClient.query(
                `SELECT id FROM organizations
                 WHERE id NOT IN (SELECT DISTINCT org_id FROM knowledge_bases)
                 LIMIT 1`
            );
            if (res.rows.length > 0) {
                fakeOrgId = res.rows[0].id as string;
            }
        } finally {
            fakeOrgClient.release();
        }

        if (!fakeOrgId) {
            // All orgs have KBs — skip gracefully
            return;
        }

        const result = await discoverWithContext(
            pool, fakeOrgId, '00000000-0000-0000-0000-000000000099', 'test question'
        );
        expect(result.snippets).toHaveLength(0);
    });
});
