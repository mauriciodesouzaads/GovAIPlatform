/**
 * Architect Delegation Router — Sprint A4/A5
 *
 * Reads work items with specific execution_hint values and routes them
 * to the appropriate adapter for execution.
 *
 * Conventions:
 *   - Same Pool + set_config pattern as architect.ts
 *   - Adapters update work item status in DB and record evidence
 *   - Human adapter is informational only (no DB state changes)
 *   - Max 3 dispatch attempts before marking blocked
 *   - dispatchWorkItem uses SELECT FOR UPDATE SKIP LOCKED for concurrency safety
 */

import { Pool } from 'pg';
import { searchSimilarChunks } from './rag';
import { recordEvidence } from './evidence';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdapterResult {
    success: boolean;
    output: Record<string, unknown>;
    error?: string;
}

export interface DispatchResult {
    workItemId: string;
    adapter: string;
    success: boolean;
    output: Record<string, unknown>;
    error?: string;
}

// ── Adapter: internal_rag ─────────────────────────────────────────────────────

export async function runInternalRagAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        if (item.execution_hint !== 'internal_rag') {
            return { success: false, output: {}, error: 'Wrong adapter for this item' };
        }
        if (item.status !== 'pending' && item.status !== 'in_progress') {
            return { success: false, output: {}, error: 'Work item not in dispatchable state' };
        }

        // 2. Mark in_progress
        await client.query(
            `UPDATE architect_work_items
             SET status = 'in_progress', dispatched_at = now(),
                 dispatch_attempts = dispatch_attempts + 1
             WHERE id = $1`,
            [workItemId]
        );

        // 3. Build search question
        const question: string = item.description ?? item.title;

        // 4. Look up knowledge base
        const kbRes = await client.query(
            `SELECT id FROM knowledge_bases WHERE org_id = $1 LIMIT 1`,
            [orgId]
        );

        if (kbRes.rows.length === 0) {
            const output = { snippets: [], message: 'No knowledge base configured' };
            await client.query(
                `UPDATE architect_work_items
                 SET status = 'done', completed_at = now(),
                     execution_context = $1
                 WHERE id = $2`,
                [JSON.stringify({ input: { question }, output, adapter: 'internal_rag' }), workItemId]
            );
            return { success: true, output };
        }

        const kbId: string = kbRes.rows[0].id;

        // 5. Search RAG
        const chunks = await searchSimilarChunks(pool, kbId, orgId, question, 5);

        // 6. Build output
        const snippets = chunks.map(c => ({
            source: kbId,
            content: c.content,
            score: c.similarity,
        }));
        const output = { snippets, question, kbId };

        // 7. Update work item as done
        await client.query(
            `UPDATE architect_work_items
             SET status = 'done', completed_at = now(),
                 execution_context = $1
             WHERE id = $2`,
            [
                JSON.stringify({
                    input: { question, kbId },
                    output: { snippets },
                    adapter: 'internal_rag',
                }),
                workItemId,
            ]
        );

        // 8. Record evidence
        await recordEvidence(pool, {
            orgId,
            category: 'data_access',
            eventType: 'ARCHITECT_ADAPTER_EXECUTED',
            resourceType: 'architect_work_item',
            resourceId: workItemId,
            metadata: { adapter: 'internal_rag', snippetCount: snippets.length },
        });

        // 9. Return result
        return { success: true, output };
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
            // On error: update dispatch_error, check attempts for blocked state
            const attemptsRes = await client.query(
                `UPDATE architect_work_items
                 SET dispatch_error = $1,
                     dispatch_attempts = dispatch_attempts + 1,
                     status = CASE
                         WHEN dispatch_attempts + 1 >= 3 THEN 'blocked'
                         ELSE 'pending'
                     END
                 WHERE id = $2 AND org_id = $3
                 RETURNING dispatch_attempts`,
                [errorMsg, workItemId, orgId]
            );
            void attemptsRes;
        } catch {
            // Non-fatal — best effort error recording
        }
        return { success: false, output: {}, error: errorMsg };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Adapter: human ────────────────────────────────────────────────────────────

export async function runHumanAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch and validate work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        // 2. Return informational output — no DB state changes
        return {
            success: true,
            output: {
                message: 'Human action required',
                item_type: item.item_type,
                title: item.title,
                description: item.description,
                ref_type: item.ref_type,
                ref_id: item.ref_id,
                instructions: 'Complete this task manually and update the work item status via PATCH /work-items/:id',
            },
        };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Adapter: agno (stub) ──────────────────────────────────────────────────────

export async function runAgnoAdapter(
    pool: Pool,
    orgId: string,
    workItemId: string,
    agnoEndpoint?: string
): Promise<AdapterResult> {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

        // 1. Fetch work item
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items WHERE id = $1 AND org_id = $2`,
            [workItemId, orgId]
        );
        if (wiRes.rows.length === 0) {
            return { success: false, output: {}, error: 'Work item not found' };
        }
        const item = wiRes.rows[0];

        // 2. Validate execution_hint
        if (item.execution_hint !== 'agno') {
            return { success: false, output: {}, error: 'Wrong adapter for this item' };
        }

        // 3. Build agno payload
        const agnoPayload = {
            work_item_id: workItemId,
            item_type: item.item_type,
            title: item.title,
            description: item.description,
            execution_context_input: {
                orgId,
                ref_type: item.ref_type,
                ref_id: item.ref_id,
            },
        };

        // 4. If AGNO_ENABLED=true and endpoint provided: call Agno service
        if (agnoEndpoint && process.env.AGNO_ENABLED === 'true') {
            const response = await fetch(`${agnoEndpoint}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(agnoPayload),
            });
            const data = await response.json() as Record<string, unknown>;
            return { success: true, output: data };
        }

        // 5. Stub response — Agno not yet enabled
        const output = {
            stub: true,
            message: 'Agno adapter not yet enabled. Set AGNO_ENABLED=true and provide AGNO_ENDPOINT to activate.',
            payload: agnoPayload,
        };

        // Update execution_context; status stays 'pending' (stub does not complete item)
        await client.query(
            `UPDATE architect_work_items
             SET execution_context = $1
             WHERE id = $2`,
            [JSON.stringify({ adapter: 'agno', stub: true, payload: agnoPayload }), workItemId]
        );

        return { success: true, output };
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }
}

// ── Delegation Router ─────────────────────────────────────────────────────────

export async function dispatchWorkItem(
    pool: Pool,
    orgId: string,
    workItemId: string
): Promise<DispatchResult> {
    const client = await pool.connect();
    let item: Record<string, unknown> | undefined;
    let guardOutcome: 'proceed' | 'locked' | 'terminal' | 'blocked' = 'proceed';

    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        await client.query('BEGIN');

        // 1. Lock with SKIP LOCKED — concurrent callers skip rather than block
        const wiRes = await client.query(
            `SELECT * FROM architect_work_items
             WHERE id = $1 AND org_id = $2
             FOR UPDATE SKIP LOCKED`,
            [workItemId, orgId]
        );

        if (wiRes.rows.length === 0) {
            // Another worker holds the lock
            guardOutcome = 'locked';
            await client.query('ROLLBACK').catch(() => {});
        } else {
            item = wiRes.rows[0];

            // 2. Check terminal status
            if (item.status === 'done' || item.status === 'cancelled') {
                guardOutcome = 'terminal';
                await client.query('ROLLBACK').catch(() => {});
            } else if ((item.dispatch_attempts as number) >= 3) {
                // 3. Check max attempts
                await client.query(
                    `UPDATE architect_work_items SET status = 'blocked' WHERE id = $1`,
                    [workItemId]
                );
                guardOutcome = 'blocked';
                await client.query('COMMIT').catch(() => {});
            } else {
                // Guard passed — commit and proceed to adapter
                await client.query('COMMIT').catch(() => {});
            }
        }
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
        throw err;
    }

    await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
    client.release();

    // 4. Handle guard outcomes
    if (guardOutcome === 'locked') {
        return {
            workItemId,
            adapter: 'locked',
            success: false,
            output: {},
            error: 'Work item locked by concurrent dispatch',
        };
    }
    if (guardOutcome === 'terminal') {
        throw new Error('Work item already terminal');
    }
    if (guardOutcome === 'blocked') {
        throw new Error('Max dispatch attempts reached');
    }

    // 5. Route by execution_hint (adapter opens its own connection)
    const hint = (item as Record<string, unknown>).execution_hint as string | null;
    let adapterName: string;
    let result: AdapterResult;

    if (hint === 'internal_rag') {
        adapterName = 'internal_rag';
        result = await runInternalRagAdapter(pool, orgId, workItemId);
    } else if (hint === 'agno') {
        adapterName = 'agno';
        result = await runAgnoAdapter(pool, orgId, workItemId);
    } else if (hint === 'human') {
        adapterName = 'human';
        result = await runHumanAdapter(pool, orgId, workItemId);
    } else {
        // No hint or unknown — default to human adapter
        adapterName = 'human';
        result = await runHumanAdapter(pool, orgId, workItemId);
    }

    // 6. Return dispatch result
    return {
        workItemId,
        adapter: adapterName,
        success: result.success,
        output: result.output,
        error: result.error,
    };
}

// ── Batch Dispatch ────────────────────────────────────────────────────────────

export async function dispatchPendingWorkItems(
    pool: Pool,
    orgId: string,
    workflowGraphId: string
): Promise<DispatchResult[]> {
    const client = await pool.connect();
    let pendingIds: string[];
    try {
        await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
        const res = await client.query(
            `SELECT id FROM architect_work_items
             WHERE workflow_graph_id = $1 AND org_id = $2 AND status = 'pending'
             ORDER BY created_at ASC`,
            [workflowGraphId, orgId]
        );
        pendingIds = res.rows.map(r => r.id as string);
    } finally {
        await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
        client.release();
    }

    // Dispatch sequentially to avoid race conditions
    const results: DispatchResult[] = [];
    for (const workItemId of pendingIds) {
        try {
            const result = await dispatchWorkItem(pool, orgId, workItemId);
            // Skip silently if another process has the lock
            if (result.error?.includes('locked')) continue;
            results.push(result);
        } catch (err: unknown) {
            results.push({
                workItemId,
                adapter: 'unknown',
                success: false,
                output: {},
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return results;
}
