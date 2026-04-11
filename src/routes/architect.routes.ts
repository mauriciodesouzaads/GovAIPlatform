/**
 * Architect Routes — Sprint A1
 *
 * All endpoints under /v1/admin/architect/*.
 * Registered via architectRoutes plugin in server.ts.
 *
 * Write consultant_audit_log for every mutating operation
 * (handled inside the domain service functions).
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import {
    createDemandCase,
    updateDemandCaseStatus,
    upsertProblemContract,
    discoverWithContext,
    acceptProblemContract,
    createDecisionSet,
    proposeDecisionSet,
    approveDecisionSet,
    rejectDecisionSet,
    compileWorkflow,
    updateWorkItem,
    listDemandCases,
    getDemandCaseFull,
    answerDiscoveryQuestion,
    addDiscoveryQuestion,
    generateArchitectDocument,
    getDiscoveryStatus,
    generateCaseSummary,
} from '../lib/architect';
import { dispatchWorkItem, dispatchPendingWorkItems } from '../lib/architect-delegation';
import { architectQueue } from '../workers/architect.worker';

export async function architectRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;

    // ── POST /v1/admin/architect/cases ────────────────────────────────────────
    fastify.post('/v1/admin/architect/cases', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { title, description, source_type, priority, due_at, requested_by } =
            request.body as any;

        if (!title || !source_type) {
            return reply.status(400).send({ error: 'title e source_type são obrigatórios.' });
        }

        const demandCase = await createDemandCase(
            pgPool, orgId,
            { title, description, source_type, priority, due_at, requested_by },
            userId
        );
        return reply.status(201).send(demandCase);
    });

    // ── GET /v1/admin/architect/cases ─────────────────────────────────────────
    fastify.get('/v1/admin/architect/cases', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { status, priority, assigned_to, limit } = request.query as any;
        const cases = await listDemandCases(pgPool, orgId, {
            status,
            priority,
            assigned_to,
            limit: limit ? parseInt(limit, 10) : 50,
        });
        return reply.send({ cases, total: cases.length });
    });

    // ── GET /v1/admin/architect/cases/:id ─────────────────────────────────────
    fastify.get('/v1/admin/architect/cases/:id', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const full = await getDemandCaseFull(pgPool, orgId, id);
        if (!full) return reply.status(404).send({ error: 'Caso não encontrado.' });
        return reply.send(full);
    });

    // ── PATCH /v1/admin/architect/cases/:id/status ────────────────────────────
    fastify.patch('/v1/admin/architect/cases/:id/status', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const { status } = request.body as any;
        if (!status) return reply.status(400).send({ error: 'status é obrigatório.' });

        await updateDemandCaseStatus(pgPool, orgId, id, status, userId);
        return reply.send({ ok: true });
    });

    // ── POST /v1/admin/architect/cases/:id/contract ───────────────────────────
    fastify.post('/v1/admin/architect/cases/:id/contract', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const {
            goal,
            constraints_json,
            non_goals_json,
            acceptance_criteria_json,
            open_questions_json,
            context_snippets_json,
            confidence_score,
        } = request.body as any;

        if (!goal) return reply.status(400).send({ error: 'goal é obrigatório.' });

        const contract = await upsertProblemContract(pgPool, orgId, id, {
            goal,
            constraints_json:         constraints_json ?? [],
            non_goals_json:           non_goals_json ?? [],
            acceptance_criteria_json: acceptance_criteria_json ?? [],
            open_questions_json:      open_questions_json ?? [],
            context_snippets_json:    context_snippets_json ?? [],
            confidence_score,
        }, userId);
        // 201 on insert (version=1), 200 on update
        const statusCode = contract.version === 1 ? 201 : 200;
        return reply.status(statusCode).send(contract);
    });

    // ── POST /v1/admin/architect/cases/:id/discover ───────────────────────────
    fastify.post('/v1/admin/architect/cases/:id/discover', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const { question } = request.body as any;
        if (!question) return reply.status(400).send({ error: 'question é obrigatório.' });

        const result = await discoverWithContext(pgPool, orgId, id, question);
        if (result.snippets.length === 0) {
            return reply.send({
                snippets: [],
                message: 'Nenhuma base de conhecimento encontrada para esta organização.',
            });
        }
        return reply.send(result);
    });

    // ── POST /v1/admin/architect/cases/:id/contract/accept ────────────────────
    fastify.post('/v1/admin/architect/cases/:id/contract/accept', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        // Find the contract for this case
        const client = await pgPool.connect();
        let contractId: string;
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                'SELECT id FROM problem_contracts WHERE demand_case_id = $1 AND org_id = $2',
                [id, orgId]
            );
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Contrato não encontrado para este caso.' });
            }
            contractId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        await acceptProblemContract(pgPool, orgId, contractId, userId);
        return reply.send({ ok: true });
    });

    // ── POST /v1/admin/architect/cases/:id/decisions ──────────────────────────
    fastify.post('/v1/admin/architect/cases/:id/decisions', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const {
            recommended_option,
            alternatives_json,
            tradeoffs_json,
            risks_json,
            rationale_md,
        } = request.body as any;

        if (!recommended_option || !rationale_md) {
            return reply.status(400).send({
                error: 'recommended_option e rationale_md são obrigatórios.',
            });
        }

        // Find the accepted contract for this case
        const client = await pgPool.connect();
        let contractId: string;
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const res = await client.query(
                `SELECT id FROM problem_contracts
                 WHERE demand_case_id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Contrato não encontrado para este caso.' });
            }
            contractId = res.rows[0].id as string;
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        const decision = await createDecisionSet(pgPool, orgId, contractId, {
            recommended_option,
            alternatives_json: alternatives_json ?? [],
            tradeoffs_json:    tradeoffs_json ?? [],
            risks_json:        risks_json ?? [],
            rationale_md,
        }, userId);
        return reply.status(201).send(decision);
    });

    // ── POST /v1/admin/architect/decisions/:decisionId/propose ────────────────
    fastify.post('/v1/admin/architect/decisions/:decisionId/propose', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { decisionId } = request.params as { decisionId: string };
        await proposeDecisionSet(pgPool, orgId, decisionId, userId);
        return reply.send({ ok: true });
    });

    // ── POST /v1/admin/architect/decisions/:decisionId/approve ────────────────
    fastify.post('/v1/admin/architect/decisions/:decisionId/approve', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { decisionId } = request.params as { decisionId: string };
        await approveDecisionSet(pgPool, orgId, decisionId, userId);
        return reply.send({ ok: true });
    });

    // ── POST /v1/admin/architect/decisions/:decisionId/reject ─────────────────
    fastify.post('/v1/admin/architect/decisions/:decisionId/reject', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { decisionId } = request.params as { decisionId: string };
        const { reason } = request.body as any;
        if (!reason) return reply.status(400).send({ error: 'reason é obrigatório.' });

        await rejectDecisionSet(pgPool, orgId, decisionId, userId, reason);
        return reply.send({ ok: true });
    });

    // ── POST /v1/admin/architect/decisions/:decisionId/compile ────────────────
    fastify.post('/v1/admin/architect/decisions/:decisionId/compile', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { decisionId } = request.params as { decisionId: string };
        const { graph_json } = request.body as any;

        if (!graph_json || !Array.isArray(graph_json.nodes) || graph_json.nodes.length < 1 || typeof graph_json.metadata !== 'object') {
            return reply.status(400).send({
                error: 'graph_json deve conter nodes (array, min 1) e metadata (object).',
            });
        }

        const result = await compileWorkflow(pgPool, orgId, decisionId, graph_json, userId);
        return reply.status(201).send(result);
    });

    // ── GET /v1/admin/architect/cases/:id/work-items ──────────────────────────
    fastify.get('/v1/admin/architect/cases/:id/work-items', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { id } = request.params as { id: string };
        const { status, item_type, limit } = request.query as any;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const params: unknown[] = [orgId];
            const clauses: string[] = [];

            // Get workflow_graph_id for this case (via decision chain)
            const wfRes = await client.query(
                `SELECT wg.id FROM workflow_graphs wg
                 JOIN architecture_decision_sets ads ON ads.id = wg.architecture_decision_set_id
                 JOIN problem_contracts pc ON pc.id = ads.problem_contract_id
                 WHERE pc.demand_case_id = $1 AND wg.org_id = $1
                 ORDER BY wg.created_at DESC LIMIT 1`,
                [id]
            );

            if (wfRes.rows.length === 0) {
                return reply.send({ workItems: [], total: 0 });
            }
            const wfId = wfRes.rows[0].id as string;

            params.push(wfId);
            clauses.push(`workflow_graph_id = $${params.length}`);

            if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
            if (item_type) { params.push(item_type); clauses.push(`item_type = $${params.length}`); }
            params.push(limit ? parseInt(limit, 10) : 50);

            const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
            const wiRes = await client.query(
                `SELECT * FROM architect_work_items
                 WHERE org_id = $1 ${where}
                 ORDER BY created_at ASC
                 LIMIT $${params.length}`,
                params
            );
            const workItems = wiRes.rows;
            return reply.send({ workItems, total: workItems.length });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── PATCH /v1/admin/architect/work-items/:workItemId ──────────────────────
    fastify.patch('/v1/admin/architect/work-items/:workItemId', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { workItemId } = request.params as { workItemId: string };
        const { status, assigned_to, result_notes, result_ref, execution_hint } = request.body as any;

        const item = await updateWorkItem(pgPool, orgId, workItemId, {
            status, assigned_to, result_notes, result_ref, execution_hint,
        }, userId);
        return reply.send(item);
    });

    // ── POST /v1/admin/architect/cases/:id/discover/answer ───────────────────
    fastify.post('/v1/admin/architect/cases/:id/discover/answer', {
        preHandler: requireRole(['admin', 'operator', 'dpo']),
        schema: {
            body: {
                type: 'object',
                required: ['questionIndex', 'answer'],
                properties: {
                    questionIndex: { type: 'integer', minimum: 0 },
                    answer: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const { questionIndex, answer } = request.body as { questionIndex: number; answer: string };
        const result = await answerDiscoveryQuestion(pgPool, orgId, id, questionIndex, answer, userId);
        return reply.send(result);
    });

    // ── POST /v1/admin/architect/cases/:id/discover/questions ────────────────
    fastify.post('/v1/admin/architect/cases/:id/discover/questions', {
        preHandler: requireRole(['admin', 'operator', 'dpo']),
        schema: {
            body: {
                type: 'object',
                required: ['question'],
                properties: {
                    question: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const { question } = request.body as { question: string };
        const contract = await addDiscoveryQuestion(pgPool, orgId, id, question, userId);
        return reply.status(201).send(contract);
    });

    // ── GET /v1/admin/architect/cases/:id/discover/status ───────────────────
    fastify.get('/v1/admin/architect/cases/:id/discover/status', {
        preHandler: requireRole(['admin', 'operator', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const status = await getDiscoveryStatus(pgPool, orgId, id);
        return reply.send(status);
    });

    // ── POST /v1/admin/architect/decisions/:decisionId/document ─────────────
    fastify.post('/v1/admin/architect/decisions/:decisionId/document', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { decisionId } = request.params as { decisionId: string };
        const result = await generateArchitectDocument(pgPool, orgId, decisionId, userId);
        return reply.status(201).send(result);
    });

    // ── GET /v1/admin/architect/cases/:id/summary ────────────────────────────
    fastify.get('/v1/admin/architect/cases/:id/summary', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        try {
            const result = await generateCaseSummary(pgPool, orgId, id, userId);
            return reply.send(result);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not found')) return reply.status(404).send({ error: msg });
            throw err;
        }
    });

    // ── POST /v1/admin/architect/work-items/:workItemId/dispatch ─────────────
    fastify.post('/v1/admin/architect/work-items/:workItemId/dispatch', {
        preHandler: requireRole(['admin', 'operator']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        try {
            // Check execution_hint before dispatching
            const hintCheck = await pgPool.query(
                `SELECT execution_hint FROM architect_work_items WHERE id = $1`,
                [workItemId]
            );
            const hint = hintCheck.rows[0]?.execution_hint;

            if (hint === 'openclaude') {
                // Async dispatch via BullMQ — returns 202 Accepted immediately
                await architectQueue.add('dispatch-openclaude', { orgId, workItemId }, {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5_000 },
                });
                return reply.status(202).send({
                    accepted: true,
                    workItemId,
                    adapter: 'openclaude',
                    message: 'OpenClaude dispatch enqueued. Poll work item status for updates.',
                });
            }

            // Synchronous dispatch for other adapters
            const result = await dispatchWorkItem(pgPool, orgId, workItemId);
            return reply.send(result);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not found')) return reply.status(404).send({ error: msg });
            if (msg.includes('terminal') || msg.includes('blocked') || msg.includes('Max dispatch')) {
                return reply.status(409).send({ error: msg });
            }
            throw err;
        }
    });

    // ── POST /v1/admin/architect/work-items/:workItemId/cancel ───────────────
    fastify.post('/v1/admin/architect/work-items/:workItemId/cancel', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `UPDATE architect_work_items
                 SET status = 'cancelled', cancelled_at = now()
                 WHERE id = $1 AND org_id = $2
                   AND status IN ('pending', 'in_progress')
                 RETURNING id, status`,
                [workItemId, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found or not cancellable' });
            }
            return reply.send({ cancelled: true, workItemId });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── GET /v1/admin/architect/work-items/:workItemId/events ────────────────
    // Returns the work item state plus all evidence records linked to it,
    // ordered chronologically. Used by the /architect drawer to render the
    // OpenClaude live execution timeline.
    fastify.get('/v1/admin/architect/work-items/:workItemId/events', {
        preHandler: requireRole(['admin', 'operator', 'auditor', 'dpo']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const wi = await client.query(
                `SELECT id, status, execution_hint, title, description, item_type,
                        execution_context, dispatch_attempts, dispatch_error,
                        worker_session_id, run_started_at, dispatched_at,
                        cancelled_at, completed_at, created_at, updated_at
                 FROM architect_work_items
                 WHERE id = $1 AND org_id = $2`,
                [workItemId, orgId]
            );
            if (wi.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found' });
            }

            const events = await client.query(
                `SELECT id, event_type, metadata, created_at
                 FROM evidence_records
                 WHERE resource_type = 'architect_work_item'
                   AND resource_id = $1
                   AND org_id = $2
                 ORDER BY created_at ASC`,
                [workItemId, orgId]
            );

            return reply.send({
                work_item: wi.rows[0],
                events: events.rows.map(e => ({
                    id: e.id,
                    type: e.event_type,
                    metadata: e.metadata,
                    timestamp: e.created_at,
                })),
            });
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }
    });

    // ── POST /v1/admin/architect/work-items/:workItemId/approve-action ───────
    // v1: stub — the adapter currently auto-approves all gRPC ActionRequired
    // events. This endpoint exists so the frontend approval bridge can be built
    // ahead of v2, which will forward UserInput back through the gRPC stream.
    fastify.post('/v1/admin/architect/work-items/:workItemId/approve-action', {
        preHandler: requireRole(['admin']),
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workItemId } = request.params as { workItemId: string };
        const body = (request.body ?? {}) as { prompt_id?: string; approved?: boolean };

        if (!body.prompt_id || typeof body.approved !== 'boolean') {
            return reply.status(400).send({ error: 'prompt_id e approved (boolean) são obrigatórios.' });
        }

        // v1: confirm work item exists; do not actually forward — adapter auto-approves
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const exists = await client.query(
                `SELECT id FROM architect_work_items WHERE id = $1 AND org_id = $2`,
                [workItemId, orgId]
            );
            if (exists.rows.length === 0) {
                return reply.status(404).send({ error: 'Work item not found' });
            }
        } finally {
            await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
            client.release();
        }

        return reply.send({
            message: 'v1: auto-approve is active — manual approval will be available in v2',
            workItemId,
            prompt_id: body.prompt_id,
            approved: body.approved,
            stubbed: true,
        });
    });

    // ── POST /v1/admin/architect/cases/:id/workflow/dispatch-all ────────────
    fastify.post('/v1/admin/architect/cases/:id/workflow/dispatch-all', {
        preHandler: requireRole(['admin']),
        schema: {
            body: {
                type: 'object',
                required: ['workflow_graph_id'],
                properties: {
                    workflow_graph_id: { type: 'string', minLength: 1 },
                },
            },
        },
    }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { workflow_graph_id } = request.body as { workflow_graph_id: string };
        const dispatched = await dispatchPendingWorkItems(pgPool, orgId, workflow_graph_id);
        return reply.send({ dispatched, total: dispatched.length });
    });
}
