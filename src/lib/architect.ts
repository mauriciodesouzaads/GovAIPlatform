/**
 * Architect Domain Service — Sprint A1
 *
 * Entry point for all Architect domain business logic.
 * Entity chain:
 *   demand_case → problem_contract → architecture_decision_set
 *     → workflow_graph → architect_work_items
 *
 * Conventions:
 *   - Every function sets app.current_org_id for RLS isolation
 *   - set_config is reset in every finally block
 *   - logConsultantAction writes to consultant_audit_log (non-fatal)
 *   - No mocks, no TODOs
 */

import { Pool } from 'pg';
import { searchSimilarChunks, estimateTokens } from './rag';
import { logConsultantAction } from './consultant-auth';
import { recordEvidence } from './evidence';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface DemandCase {
    id: string;
    org_id: string;
    title: string;
    description: string | null;
    source_type: string;
    source_ref: string | null;
    status: string;
    priority: string;
    requested_by: string | null;
    assigned_to: string | null;
    due_at: Date | null;
    closed_at: Date | null;
    closed_reason: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface ProblemContract {
    id: string;
    org_id: string;
    demand_case_id: string;
    version: number;
    goal: string;
    constraints_json: unknown[];
    non_goals_json: unknown[];
    acceptance_criteria_json: unknown[];
    open_questions_json: unknown[];
    context_snippets_json: unknown[];
    confidence_score: number;
    status: string;
    accepted_by: string | null;
    accepted_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface ArchitectureDecisionSet {
    id: string;
    org_id: string;
    problem_contract_id: string;
    recommended_option: string;
    alternatives_json: unknown[];
    tradeoffs_json: unknown[];
    risks_json: unknown[];
    rationale_md: string;
    status: string;
    proposed_by: string | null;
    proposed_at: Date | null;
    approved_by: string | null;
    approved_at: Date | null;
    rejection_reason: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface WorkflowGraph {
    id: string;
    org_id: string;
    architecture_decision_set_id: string;
    version: number;
    graph_json: Record<string, unknown>;
    status: string;
    compiled_at: Date | null;
    delegated_at: Date | null;
    completed_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface ArchitectWorkItem {
    id: string;
    org_id: string;
    workflow_graph_id: string;
    node_id: string;
    item_type: string;
    title: string;
    description: string | null;
    ref_type: string | null;
    ref_id: string | null;
    status: string;
    assigned_to: string | null;
    due_at: Date | null;
    completed_at: Date | null;
    result_ref: string | null;
    result_notes: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface DemandCaseFull {
    case: DemandCase;
    contract: ProblemContract | null;
    decisions: ArchitectureDecisionSet[];
    workflow: WorkflowGraph | null;
    workItems: ArchitectWorkItem[];
}

// ── Status transition map ─────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
    draft:       ['intake', 'closed'],
    intake:      ['discovery', 'closed'],
    discovery:   ['contracting', 'closed'],
    contracting: ['decision', 'closed'],
    decision:    ['compiling', 'closed'],
    compiling:   ['delegated', 'closed'],
    delegated:   ['closed'],
    closed:      [],
};

const VALID_ITEM_TYPES = new Set([
    'shield_review', 'catalog_review', 'policy_config',
    'compliance_check', 'human_task', 'rag_research',
]);

// ── A. createDemandCase ───────────────────────────────────────────────────────

export async function createDemandCase(
    pool: Pool,
    orgId: string,
    payload: {
        title: string;
        description?: string;
        source_type: string;
        source_ref?: string;
        priority?: string;
        requested_by?: string;
        due_at?: string | Date;
    },
    actorId: string
): Promise<DemandCase> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `INSERT INTO demand_cases
             (org_id, title, description, source_type, source_ref,
              priority, requested_by, due_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
             RETURNING *`,
            [
                orgId,
                payload.title,
                payload.description ?? null,
                payload.source_type,
                payload.source_ref ?? null,
                payload.priority ?? 'medium',
                payload.requested_by ?? null,
                payload.due_at ?? null,
            ]
        );
        const row = res.rows[0] as DemandCase;
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_CASE_CREATED',
            { caseId: row.id, title: row.title }, 'demand_case', row.id);
        return row;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── B. updateDemandCaseStatus ─────────────────────────────────────────────────

export async function updateDemandCaseStatus(
    pool: Pool,
    orgId: string,
    caseId: string,
    newStatus: string,
    actorId: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const cur = await client.query(
            'SELECT status FROM demand_cases WHERE id = $1 AND org_id = $2',
            [caseId, orgId]
        );
        if (cur.rows.length === 0) throw new Error('Demand case not found.');
        const current = cur.rows[0].status as string;
        const allowed = VALID_TRANSITIONS[current] ?? [];
        if (!allowed.includes(newStatus)) {
            throw new Error(`Invalid transition: ${current} → ${newStatus}`);
        }
        await client.query(
            `UPDATE demand_cases
             SET status = $1,
                 closed_at   = CASE WHEN $1 = 'closed' THEN now() ELSE closed_at END,
                 updated_at  = now()
             WHERE id = $2 AND org_id = $3`,
            [newStatus, caseId, orgId]
        );
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_CASE_STATUS_CHANGED',
            { from: current, to: newStatus }, 'demand_case', caseId);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── C. upsertProblemContract ──────────────────────────────────────────────────

export async function upsertProblemContract(
    pool: Pool,
    orgId: string,
    demandCaseId: string,
    payload: {
        goal: string;
        constraints_json: unknown[];
        non_goals_json: unknown[];
        acceptance_criteria_json: unknown[];
        open_questions_json: unknown[];
        context_snippets_json?: unknown[];
        confidence_score?: number;
    }
): Promise<ProblemContract> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        const existing = await client.query(
            'SELECT id, status FROM problem_contracts WHERE demand_case_id = $1 AND org_id = $2',
            [demandCaseId, orgId]
        );

        let row: ProblemContract;

        if (existing.rows.length === 0) {
            // INSERT — advance case to 'contracting'
            const res = await client.query(
                `INSERT INTO problem_contracts
                 (org_id, demand_case_id, goal, constraints_json, non_goals_json,
                  acceptance_criteria_json, open_questions_json, context_snippets_json,
                  confidence_score)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    orgId, demandCaseId,
                    payload.goal,
                    JSON.stringify(payload.constraints_json),
                    JSON.stringify(payload.non_goals_json),
                    JSON.stringify(payload.acceptance_criteria_json),
                    JSON.stringify(payload.open_questions_json),
                    JSON.stringify(payload.context_snippets_json ?? []),
                    payload.confidence_score ?? 0,
                ]
            );
            row = res.rows[0] as ProblemContract;
            // Advance case to contracting
            await client.query(
                `UPDATE demand_cases SET status = 'contracting', updated_at = now()
                 WHERE id = $1 AND org_id = $2 AND status IN
                 ('draft','intake','discovery')`,
                [demandCaseId, orgId]
            );
        } else {
            const existingStatus = existing.rows[0].status as string;
            if (existingStatus === 'accepted') {
                throw new Error('problem_contracts is immutable after acceptance');
            }
            const res = await client.query(
                `UPDATE problem_contracts
                 SET goal                     = $1,
                     constraints_json         = $2,
                     non_goals_json           = $3,
                     acceptance_criteria_json = $4,
                     open_questions_json      = $5,
                     context_snippets_json    = $6,
                     confidence_score         = $7,
                     version                  = version + 1
                 WHERE id = $8 AND org_id = $9
                 RETURNING *`,
                [
                    payload.goal,
                    JSON.stringify(payload.constraints_json),
                    JSON.stringify(payload.non_goals_json),
                    JSON.stringify(payload.acceptance_criteria_json),
                    JSON.stringify(payload.open_questions_json),
                    JSON.stringify(payload.context_snippets_json ?? []),
                    payload.confidence_score ?? 0,
                    existing.rows[0].id,
                    orgId,
                ]
            );
            row = res.rows[0] as ProblemContract;
        }

        await logConsultantAction(pool, orgId, orgId, 'ARCHITECT_CONTRACT_UPSERTED',
            { contractId: row.id, demandCaseId }, 'problem_contract', row.id);
        return row;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── D. discoverWithContext ────────────────────────────────────────────────────

export async function discoverWithContext(
    pool: Pool,
    orgId: string,
    caseId: string,
    question: string
): Promise<{ snippets: Array<{ source: string; content: string; score: number }> }> {
    const client = await pool.connect();
    let kbId: string | null = null;
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const kbRes = await client.query(
            'SELECT id FROM knowledge_bases WHERE org_id = $1 LIMIT 1',
            [orgId]
        );
        if (kbRes.rows.length === 0) {
            return { snippets: [] };
        }
        kbId = kbRes.rows[0].id as string;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }

    // RAG search — may throw if GEMINI_API_KEY not set or no embeddings available
    const candidates = await searchSimilarChunks(pool, kbId!, orgId, question, 10);

    // Token-aware limit of ~2000 tokens
    const TOKEN_LIMIT = 2000;
    const snippets: Array<{ source: string; content: string; score: number }> = [];
    let usedTokens = 0;

    for (const c of candidates) {
        const tokens = estimateTokens(c.content);
        if (usedTokens + tokens > TOKEN_LIMIT) break;
        snippets.push({
            source: kbId!,
            content: c.content,
            score: c.similarity,
        });
        usedTokens += tokens;
    }

    return { snippets };
}

// ── E. acceptProblemContract ──────────────────────────────────────────────────

export async function acceptProblemContract(
    pool: Pool,
    orgId: string,
    contractId: string,
    actorId: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `UPDATE problem_contracts
             SET status = 'accepted', accepted_by = $1, accepted_at = now()
             WHERE id = $2 AND org_id = $3
             RETURNING demand_case_id`,
            [actorId, contractId, orgId]
        );
        if (res.rows.length === 0) throw new Error('Problem contract not found.');
        const demandCaseId = res.rows[0].demand_case_id as string;
        await client.query(
            `UPDATE demand_cases SET status = 'decision', updated_at = now()
             WHERE id = $1 AND org_id = $2`,
            [demandCaseId, orgId]
        );
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_CONTRACT_ACCEPTED',
            { contractId }, 'problem_contract', contractId);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── F. createDecisionSet ──────────────────────────────────────────────────────

export async function createDecisionSet(
    pool: Pool,
    orgId: string,
    contractId: string,
    payload: {
        recommended_option: string;
        alternatives_json: unknown[];
        tradeoffs_json: unknown[];
        risks_json: unknown[];
        rationale_md: string;
    },
    actorId: string
): Promise<ArchitectureDecisionSet> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `INSERT INTO architecture_decision_sets
             (org_id, problem_contract_id, recommended_option,
              alternatives_json, tradeoffs_json, risks_json, rationale_md)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                orgId, contractId,
                payload.recommended_option,
                JSON.stringify(payload.alternatives_json),
                JSON.stringify(payload.tradeoffs_json),
                JSON.stringify(payload.risks_json),
                payload.rationale_md,
            ]
        );
        const row = res.rows[0] as ArchitectureDecisionSet;
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_DECISION_CREATED',
            { decisionSetId: row.id, contractId }, 'architecture_decision_set', row.id);
        return row;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── G. proposeDecisionSet ─────────────────────────────────────────────────────

export async function proposeDecisionSet(
    pool: Pool,
    orgId: string,
    decisionSetId: string,
    actorId: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `UPDATE architecture_decision_sets
             SET status = 'proposed', proposed_by = $1, proposed_at = now()
             WHERE id = $2 AND org_id = $3`,
            [actorId, decisionSetId, orgId]
        );
        if ((res.rowCount ?? 0) === 0) throw new Error('Decision set not found.');
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_DECISION_PROPOSED',
            { decisionSetId }, 'architecture_decision_set', decisionSetId);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── H. approveDecisionSet ─────────────────────────────────────────────────────

export async function approveDecisionSet(
    pool: Pool,
    orgId: string,
    decisionSetId: string,
    actorId: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `UPDATE architecture_decision_sets
             SET status = 'approved', approved_by = $1, approved_at = now()
             WHERE id = $2 AND org_id = $3
             RETURNING problem_contract_id`,
            [actorId, decisionSetId, orgId]
        );
        if (res.rows.length === 0) throw new Error('Decision set not found.');
        const contractId = res.rows[0].problem_contract_id as string;
        // Advance demand_case to 'compiling'
        await client.query(
            `UPDATE demand_cases dc
             SET status = 'compiling', updated_at = now()
             FROM problem_contracts pc
             WHERE pc.id = $1
               AND dc.id = pc.demand_case_id
               AND dc.org_id = $2`,
            [contractId, orgId]
        );
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_DECISION_APPROVED',
            { decisionSetId }, 'architecture_decision_set', decisionSetId);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── I. rejectDecisionSet ──────────────────────────────────────────────────────

export async function rejectDecisionSet(
    pool: Pool,
    orgId: string,
    decisionSetId: string,
    actorId: string,
    reason: string
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `UPDATE architecture_decision_sets
             SET status = 'rejected', rejection_reason = $1
             WHERE id = $2 AND org_id = $3`,
            [reason, decisionSetId, orgId]
        );
        if ((res.rowCount ?? 0) === 0) throw new Error('Decision set not found.');
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_DECISION_REJECTED',
            { decisionSetId, reason }, 'architecture_decision_set', decisionSetId);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── J. compileWorkflow ────────────────────────────────────────────────────────

export async function compileWorkflow(
    pool: Pool,
    orgId: string,
    decisionSetId: string,
    graphJson: { nodes: Array<{ id: string; type: string; label: string; config?: Record<string, unknown> }>; edges: unknown[]; metadata: Record<string, unknown> },
    actorId: string
): Promise<{ workflow: WorkflowGraph; workItems: ArchitectWorkItem[] }> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Insert workflow_graph as 'compiled'
        const wfRes = await client.query(
            `INSERT INTO workflow_graphs
             (org_id, architecture_decision_set_id, graph_json, status, compiled_at)
             VALUES ($1, $2, $3, 'compiled', now())
             RETURNING *`,
            [orgId, decisionSetId, JSON.stringify(graphJson)]
        );
        const workflow = wfRes.rows[0] as WorkflowGraph;

        // 2. Generate work items for valid node types
        const workItems: ArchitectWorkItem[] = [];
        for (const node of graphJson.nodes) {
            if (!VALID_ITEM_TYPES.has(node.type)) continue;
            const wiRes = await client.query(
                `INSERT INTO architect_work_items
                 (org_id, workflow_graph_id, node_id, item_type, title,
                  description, ref_type, ref_id, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
                 RETURNING *`,
                [
                    orgId,
                    workflow.id,
                    node.id,
                    node.type,
                    node.label,
                    (node.config?.description as string) ?? null,
                    (node.config?.ref_type as string) ?? null,
                    (node.config?.ref_id as string) ?? null,
                ]
            );
            workItems.push(wiRes.rows[0] as ArchitectWorkItem);
        }

        // 3. Update workflow to 'delegated'
        await client.query(
            `UPDATE workflow_graphs
             SET status = 'delegated', delegated_at = now()
             WHERE id = $1`,
            [workflow.id]
        );
        workflow.status = 'delegated';
        workflow.delegated_at = new Date();

        // 4. Advance demand_case to 'delegated'
        await client.query(
            `UPDATE demand_cases dc
             SET status = 'delegated', updated_at = now()
             FROM architecture_decision_sets ads
             WHERE ads.id = $1
               AND dc.id = (
                   SELECT pc.demand_case_id FROM problem_contracts pc
                   WHERE pc.id = ads.problem_contract_id
               )
               AND dc.org_id = $2`,
            [decisionSetId, orgId]
        );

        await client.query('COMMIT');
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_WORKFLOW_COMPILED',
            { workflowId: workflow.id, workItemCount: workItems.length },
            'workflow_graph', workflow.id);
        return { workflow, workItems };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── K. updateWorkItem ─────────────────────────────────────────────────────────

export async function updateWorkItem(
    pool: Pool,
    orgId: string,
    workItemId: string,
    patch: {
        status?: string;
        assigned_to?: string | null;
        result_notes?: string | null;
        result_ref?: string | null;
        completed_at?: Date | null;
    },
    actorId: string
): Promise<ArchitectWorkItem> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `UPDATE architect_work_items
             SET status       = COALESCE($1, status),
                 assigned_to  = CASE WHEN $2::text IS NULL THEN assigned_to
                                     ELSE $2::uuid END,
                 result_notes = COALESCE($3, result_notes),
                 result_ref   = CASE WHEN $4::text IS NULL THEN result_ref
                                     ELSE $4::uuid END,
                 completed_at = CASE
                     WHEN $1 = 'done' AND completed_at IS NULL THEN now()
                     WHEN $5::timestamptz IS NOT NULL THEN $5::timestamptz
                     ELSE completed_at
                 END
             WHERE id = $6 AND org_id = $7
             RETURNING *`,
            [
                patch.status ?? null,
                patch.assigned_to ?? null,
                patch.result_notes ?? null,
                patch.result_ref ?? null,
                patch.completed_at ?? null,
                workItemId,
                orgId,
            ]
        );
        if (res.rows.length === 0) throw new Error('Work item not found.');
        const row = res.rows[0] as ArchitectWorkItem;
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_WORK_ITEM_UPDATED',
            { workItemId, patch }, 'architect_work_item', workItemId);
        return row;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── L. listDemandCases ────────────────────────────────────────────────────────

export async function listDemandCases(
    pool: Pool,
    orgId: string,
    filters: {
        status?: string;
        priority?: string;
        assigned_to?: string;
        limit?: number;
    } = {}
): Promise<DemandCase[]> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const params: unknown[] = [orgId];
        const clauses: string[] = [];

        if (filters.status) {
            params.push(filters.status);
            clauses.push(`status = $${params.length}`);
        }
        if (filters.priority) {
            params.push(filters.priority);
            clauses.push(`priority = $${params.length}`);
        }
        if (filters.assigned_to) {
            params.push(filters.assigned_to);
            clauses.push(`assigned_to = $${params.length}::uuid`);
        }
        params.push(filters.limit ?? 50);

        const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
        const res = await client.query(
            `SELECT * FROM demand_cases
             WHERE org_id = $1 ${where}
             ORDER BY
               CASE priority
                 WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                 WHEN 'medium' THEN 3 ELSE 4
               END,
               created_at DESC
             LIMIT $${params.length}`,
            params
        );
        return res.rows as DemandCase[];
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── M. getDemandCaseFull ──────────────────────────────────────────────────────

export async function getDemandCaseFull(
    pool: Pool,
    orgId: string,
    caseId: string
): Promise<DemandCaseFull | null> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        const caseRes = await client.query(
            'SELECT * FROM demand_cases WHERE id = $1 AND org_id = $2',
            [caseId, orgId]
        );
        if (caseRes.rows.length === 0) return null;
        const demandCase = caseRes.rows[0] as DemandCase;

        const contractRes = await client.query(
            'SELECT * FROM problem_contracts WHERE demand_case_id = $1 AND org_id = $2',
            [caseId, orgId]
        );
        const contract = contractRes.rows.length > 0
            ? (contractRes.rows[0] as ProblemContract)
            : null;

        let decisions: ArchitectureDecisionSet[] = [];
        let workflow: WorkflowGraph | null = null;
        let workItems: ArchitectWorkItem[] = [];

        if (contract) {
            const decisionsRes = await client.query(
                `SELECT * FROM architecture_decision_sets
                 WHERE problem_contract_id = $1 AND org_id = $2
                 ORDER BY created_at DESC`,
                [contract.id, orgId]
            );
            decisions = decisionsRes.rows as ArchitectureDecisionSet[];

            // Latest workflow from the most recently approved decision set
            const approvedDecision = decisions.find(d => d.status === 'approved');
            if (approvedDecision) {
                const wfRes = await client.query(
                    `SELECT * FROM workflow_graphs
                     WHERE architecture_decision_set_id = $1 AND org_id = $2
                     ORDER BY created_at DESC LIMIT 1`,
                    [approvedDecision.id, orgId]
                );
                if (wfRes.rows.length > 0) {
                    workflow = wfRes.rows[0] as WorkflowGraph;
                    const wiRes = await client.query(
                        `SELECT * FROM architect_work_items
                         WHERE workflow_graph_id = $1 AND org_id = $2
                         ORDER BY created_at ASC`,
                        [workflow.id, orgId]
                    );
                    workItems = wiRes.rows as ArchitectWorkItem[];
                }
            }
        }

        return { case: demandCase, contract, decisions, workflow, workItems };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
// ── Confidence score helper ───────────────────────────────────────────────────

function calcConfidenceScore(
    openQuestions: Array<{ answered: boolean }>,
    acceptanceCriteria: unknown[],
    constraints: unknown[]
): number {
    const base = 40;
    const total = openQuestions.length;
    const answered = openQuestions.filter(q => q.answered).length;
    const questionBonus = total > 0 ? (answered / total) * 30 : 0;
    const criteriaBonus = acceptanceCriteria.length > 0 ? 20 : 0;
    const constraintBonus = constraints.length > 0 ? 10 : 0;
    return Math.min(100, Math.round(base + questionBonus + criteriaBonus + constraintBonus));
}

// ── N. answerDiscoveryQuestion ────────────────────────────────────────────────

export async function answerDiscoveryQuestion(
    pool: Pool,
    orgId: string,
    caseId: string,
    questionIndex: number,
    answer: string,
    actorId: string
): Promise<{ contract: ProblemContract; confidenceScore: number; readyForAcceptance: boolean }> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id, status, open_questions_json, acceptance_criteria_json, constraints_json
             FROM problem_contracts
             WHERE demand_case_id = $1 AND org_id = $2`,
            [caseId, orgId]
        );
        if (res.rows.length === 0) throw new Error('Problem contract not found.');
        const row = res.rows[0];
        if (row.status === 'accepted') throw new Error('Contract already accepted');
        const questions: Array<{ question: string; answered: boolean; answer: string | null }> =
            Array.isArray(row.open_questions_json) ? row.open_questions_json : [];
        if (questionIndex < 0 || questionIndex >= questions.length) {
            throw new Error('Invalid question index');
        }
        questions[questionIndex].answered = true;
        questions[questionIndex].answer = answer;
        const criteria: unknown[] = Array.isArray(row.acceptance_criteria_json) ? row.acceptance_criteria_json : [];
        const constraints: unknown[] = Array.isArray(row.constraints_json) ? row.constraints_json : [];
        const score = calcConfidenceScore(questions, criteria, constraints);
        const updated = await client.query(
            `UPDATE problem_contracts
             SET open_questions_json = $1, confidence_score = $2, updated_at = now()
             WHERE id = $3 AND org_id = $4
             RETURNING *`,
            [JSON.stringify(questions), score, row.id, orgId]
        );
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_QUESTION_ANSWERED',
            { contractId: row.id, questionIndex, caseId }, 'problem_contract', row.id);
        const contract = updated.rows[0] as ProblemContract;
        return { contract, confidenceScore: score, readyForAcceptance: score >= 70 };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── O. addDiscoveryQuestion ───────────────────────────────────────────────────

export async function addDiscoveryQuestion(
    pool: Pool,
    orgId: string,
    caseId: string,
    question: string,
    actorId: string
): Promise<ProblemContract> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id, status, open_questions_json
             FROM problem_contracts
             WHERE demand_case_id = $1 AND org_id = $2`,
            [caseId, orgId]
        );
        if (res.rows.length === 0) throw new Error('Problem contract not found.');
        const row = res.rows[0];
        if (row.status === 'accepted') throw new Error('Contract already accepted');
        const questions: Array<{ question: string; answered: boolean; answer: string | null }> =
            Array.isArray(row.open_questions_json) ? row.open_questions_json : [];
        questions.push({ question, answered: false, answer: null });
        const updated = await client.query(
            `UPDATE problem_contracts
             SET open_questions_json = $1, updated_at = now()
             WHERE id = $2 AND org_id = $3
             RETURNING *`,
            [JSON.stringify(questions), row.id, orgId]
        );
        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_QUESTION_ADDED',
            { contractId: row.id, question, caseId }, 'problem_contract', row.id);
        return updated.rows[0] as ProblemContract;
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── P. generateArchitectDocument ─────────────────────────────────────────────

export async function generateArchitectDocument(
    pool: Pool,
    orgId: string,
    decisionSetId: string,
    actorId: string
): Promise<{ content: string; evidenceId: string }> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        const decRes = await client.query(
            `SELECT ads.*, pc.goal, pc.constraints_json, pc.acceptance_criteria_json,
                    pc.non_goals_json, pc.context_snippets_json,
                    dc.title AS case_title, dc.description AS case_description
             FROM architecture_decision_sets ads
             JOIN problem_contracts pc ON pc.id = ads.problem_contract_id
             JOIN demand_cases dc ON dc.id = pc.demand_case_id
             WHERE ads.id = $1 AND ads.org_id = $2`,
            [decisionSetId, orgId]
        );
        if (decRes.rows.length === 0) throw new Error('Decision set not found');
        const row = decRes.rows[0];

        const prompt = `You are an enterprise AI governance architect. Generate a formal Architecture Decision Record (ADR) document in Markdown based on the following:

## Case
Title: ${row.case_title}
${row.case_description ? `Description: ${row.case_description}` : ''}

## Problem Contract
Goal: ${row.goal}
Constraints: ${JSON.stringify(row.constraints_json)}
Non-goals: ${JSON.stringify(row.non_goals_json)}
Acceptance Criteria: ${JSON.stringify(row.acceptance_criteria_json)}

## Architecture Decision
Recommended Option: ${row.recommended_option}
Alternatives: ${JSON.stringify(row.alternatives_json)}
Tradeoffs: ${JSON.stringify(row.tradeoffs_json)}
Risks: ${JSON.stringify(row.risks_json)}
Rationale:
${row.rationale_md}

Generate a complete ADR document with sections: Title, Status, Context, Decision, Consequences, Risks, and Implementation Notes.`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 2048,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error: ${err}`);
        }

        const data = await response.json() as {
            content: Array<{ type: string; text: string }>;
        };
        const content = data.content.find(c => c.type === 'text')?.text ?? '';

        const evidenceResult = await recordEvidence(pool, {
            orgId,
            category: 'policy_enforcement',
            eventType: 'ARCHITECT_DOCUMENT_GENERATED',
            actorId,
            resourceType: 'architecture_decision_set',
            resourceId: decisionSetId,
            metadata: { decisionSetId, caseTitle: row.case_title, contentLength: content.length },
        });
        const evidenceId = evidenceResult?.id ?? '';

        await logConsultantAction(pool, actorId, orgId, 'ARCHITECT_DOCUMENT_GENERATED',
            { decisionSetId, evidenceId }, 'architecture_decision_set', decisionSetId);

        return { content, evidenceId };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Q. getDiscoveryStatus ─────────────────────────────────────────────────────

export async function getDiscoveryStatus(
    pool: Pool,
    orgId: string,
    caseId: string
): Promise<{
    caseStatus: string;
    contractExists: boolean;
    contractStatus: string | null;
    confidenceScore: number;
    totalQuestions: number;
    answeredQuestions: number;
    readyForAcceptance: boolean;
    hasAcceptanceCriteria: boolean;
}> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT dc.status AS case_status,
                    pc.id AS contract_id,
                    pc.status AS contract_status,
                    pc.confidence_score,
                    pc.open_questions_json,
                    pc.acceptance_criteria_json
             FROM demand_cases dc
             LEFT JOIN problem_contracts pc ON pc.demand_case_id = dc.id AND pc.org_id = dc.org_id
             WHERE dc.id = $1 AND dc.org_id = $2`,
            [caseId, orgId]
        );
        if (res.rows.length === 0) throw new Error('Demand case not found');
        const row = res.rows[0];
        const questions: Array<{ answered: boolean }> =
            Array.isArray(row.open_questions_json) ? row.open_questions_json : [];
        const criteria: unknown[] =
            Array.isArray(row.acceptance_criteria_json) ? row.acceptance_criteria_json : [];
        const answeredQuestions = questions.filter(q => q.answered).length;
        const confidenceScore = row.confidence_score ?? 0;
        return {
            caseStatus: row.case_status,
            contractExists: row.contract_id !== null,
            contractStatus: row.contract_status ?? null,
            confidenceScore,
            totalQuestions: questions.length,
            answeredQuestions,
            readyForAcceptance: confidenceScore >= 70,
            hasAcceptanceCriteria: criteria.length > 0,
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}
