/**
 * Workflow Templates Routes — FASE 5c
 *
 * CRUD para architect_workflow_templates + endpoint /instantiate.
 * Inspirado em claude-plugins-official:
 *   - code-review: workflow paralelo com filtro de confiança
 *   - feature-dev: 7 fases discovery → exploration → questions → architecture → impl → review → summary
 *
 * /instantiate cria toda a cadeia FK do Architect:
 *   demand_case → problem_contract → decision_set → workflow_graph → work_items[]
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

interface TemplatePhase {
    name: string;
    description?: string;
    execution_hint?: string;
    auto_advance?: boolean;
}

interface TemplateBody {
    name?: string;
    description?: string;
    category?: string;
    phases?: TemplatePhase[];
    default_execution_hint?: string;
    estimated_duration_minutes?: number;
    is_active?: boolean;
}

const VALID_HINTS = ['mcp', 'agno', 'human', 'claude_code', 'internal_rag', 'openclaude'];

export async function workflowTemplatesRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;
    const auth      = requireRole(['admin', 'dpo', 'operator']);
    const authWrite = requireRole(['admin']);

    // ── GET /v1/admin/architect/templates ─────────────────────────────────────
    fastify.get('/v1/admin/architect/templates', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { category } = (request.query ?? {}) as { category?: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const where: string[] = ['org_id = $1', 'is_active = true'];
            const params: any[] = [orgId];
            if (category) {
                params.push(category);
                where.push(`category = $${params.length}`);
            }

            const result = await client.query(
                `SELECT id, name, description, category, phases, default_execution_hint,
                        estimated_duration_minutes, is_active, is_system,
                        created_by, created_at, updated_at
                 FROM architect_workflow_templates
                 WHERE ${where.join(' AND ')}
                 ORDER BY is_system DESC, name ASC`,
                params
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/architect/templates/:id ─────────────────────────────────
    fastify.get('/v1/admin/architect/templates/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, name, description, category, phases, default_execution_hint,
                        estimated_duration_minutes, is_active, is_system,
                        created_by, created_at, updated_at
                 FROM architect_workflow_templates
                 WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Template não encontrado.' });
            }
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/architect/templates ────────────────────────────────────
    fastify.post('/v1/admin/architect/templates', { preHandler: authWrite }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const body = (request.body ?? {}) as TemplateBody;

        if (!body.name || !Array.isArray(body.phases) || body.phases.length === 0) {
            return reply.status(400).send({ error: 'name e phases (array não vazio) são obrigatórios.' });
        }

        const defaultHint = body.default_execution_hint ?? 'human';
        if (!VALID_HINTS.includes(defaultHint)) {
            return reply.status(400).send({ error: `default_execution_hint inválido. Use: ${VALID_HINTS.join(', ')}` });
        }

        // Valida cada phase
        for (const phase of body.phases) {
            if (!phase.name) {
                return reply.status(400).send({ error: 'Cada phase precisa ter um name.' });
            }
            if (phase.execution_hint && !VALID_HINTS.includes(phase.execution_hint)) {
                return reply.status(400).send({ error: `execution_hint da phase "${phase.name}" inválido.` });
            }
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO architect_workflow_templates
                    (org_id, name, description, category, phases, default_execution_hint,
                     estimated_duration_minutes, is_active, is_system, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
                 RETURNING id, name, description, category, phases, default_execution_hint,
                           estimated_duration_minutes, is_active, is_system,
                           created_by, created_at, updated_at`,
                [
                    orgId,
                    body.name,
                    body.description ?? null,
                    body.category ?? null,
                    JSON.stringify(body.phases),
                    defaultHint,
                    body.estimated_duration_minutes ?? null,
                    body.is_active ?? true,
                    userId ?? null,
                ]
            );
            return reply.status(201).send(result.rows[0]);
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Já existe um template com esse nome.' });
            }
            throw err;
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/architect/templates/:id ─────────────────────────────────
    fastify.put('/v1/admin/architect/templates/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const body   = (request.body ?? {}) as TemplateBody;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                `SELECT is_system FROM architect_workflow_templates WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Template não encontrado.' });
            }
            const isSystem = existing.rows[0].is_system as boolean;

            const sets: string[] = [];
            const params: any[] = [];

            // System templates: somente phases, description e is_active editáveis
            if (body.description !== undefined) {
                params.push(body.description);
                sets.push(`description = $${params.length}`);
            }
            if (body.phases !== undefined) {
                if (!Array.isArray(body.phases) || body.phases.length === 0) {
                    return reply.status(400).send({ error: 'phases deve ser array não vazio.' });
                }
                params.push(JSON.stringify(body.phases));
                sets.push(`phases = $${params.length}`);
            }
            if (body.is_active !== undefined) {
                params.push(body.is_active);
                sets.push(`is_active = $${params.length}`);
            }

            if (!isSystem) {
                if (body.name !== undefined) {
                    params.push(body.name);
                    sets.push(`name = $${params.length}`);
                }
                if (body.category !== undefined) {
                    params.push(body.category);
                    sets.push(`category = $${params.length}`);
                }
                if (body.default_execution_hint !== undefined) {
                    if (!VALID_HINTS.includes(body.default_execution_hint)) {
                        return reply.status(400).send({ error: 'default_execution_hint inválido.' });
                    }
                    params.push(body.default_execution_hint);
                    sets.push(`default_execution_hint = $${params.length}`);
                }
                if (body.estimated_duration_minutes !== undefined) {
                    params.push(body.estimated_duration_minutes);
                    sets.push(`estimated_duration_minutes = $${params.length}`);
                }
            }

            if (sets.length === 0) {
                return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });
            }

            params.push(id);
            params.push(orgId);
            const result = await client.query(
                `UPDATE architect_workflow_templates
                 SET ${sets.join(', ')}
                 WHERE id = $${params.length - 1} AND org_id = $${params.length}
                 RETURNING id, name, description, category, phases, default_execution_hint,
                           estimated_duration_minutes, is_active, is_system,
                           created_by, created_at, updated_at`,
                params
            );
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/architect/templates/:id ──────────────────────────────
    fastify.delete('/v1/admin/architect/templates/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                `SELECT is_system FROM architect_workflow_templates WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Template não encontrado.' });
            }
            if (existing.rows[0].is_system) {
                return reply.status(403).send({ error: 'Templates do sistema não podem ser deletados.' });
            }

            await client.query(
                `DELETE FROM architect_workflow_templates WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/architect/templates/:id/instantiate ────────────────────
    // Cria toda a cadeia: demand_case → problem_contract → decision_set → workflow_graph → work_items[]
    fastify.post('/v1/admin/architect/templates/:id/instantiate', { preHandler: authWrite }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };
        const body   = (request.body ?? {}) as { title?: string; description?: string; priority?: string };

        const title = body.title ?? 'Workflow instanciado a partir de template';
        const description = body.description ?? null;
        const priority = body.priority ?? 'medium';

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query('BEGIN');

            // 1. Carrega o template
            const tplRes = await client.query(
                `SELECT id, name, description, phases, default_execution_hint
                 FROM architect_workflow_templates WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (tplRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(404).send({ error: 'Template não encontrado.' });
            }
            const tpl = tplRes.rows[0];
            const phases: TemplatePhase[] = Array.isArray(tpl.phases)
                ? tpl.phases
                : JSON.parse(tpl.phases || '[]');

            if (phases.length === 0) {
                await client.query('ROLLBACK');
                return reply.status(400).send({ error: 'Template não tem fases definidas.' });
            }

            // 2. Cria demand_case
            const dcRes = await client.query(
                `INSERT INTO demand_cases (org_id, title, description, source_type, status, priority, requested_by)
                 VALUES ($1, $2, $3, 'internal', 'compiling', $4, $5)
                 RETURNING id`,
                [orgId, title, description, priority, userId ?? null]
            );
            const demandCaseId = dcRes.rows[0].id as string;

            // 3. Cria problem_contract
            const pcRes = await client.query(
                `INSERT INTO problem_contracts (org_id, demand_case_id, version, goal, status, accepted_by, accepted_at)
                 VALUES ($1, $2, 1, $3, 'accepted', $4, now())
                 RETURNING id`,
                [orgId, demandCaseId, `Instanciado de template: ${tpl.name}`, userId ?? null]
            );
            const contractId = pcRes.rows[0].id as string;

            // 4. Cria architecture_decision_set
            const adsRes = await client.query(
                `INSERT INTO architecture_decision_sets
                    (org_id, problem_contract_id, recommended_option, rationale_md, status, proposed_by, proposed_at, approved_by, approved_at)
                 VALUES ($1, $2, $3, $4, 'approved', $5, now(), $5, now())
                 RETURNING id`,
                [
                    orgId,
                    contractId,
                    `Executar template "${tpl.name}"`,
                    `Instanciação direta de template ${tpl.name} (${phases.length} fases).`,
                    userId ?? null,
                ]
            );
            const decisionSetId = adsRes.rows[0].id as string;

            // 5. Cria workflow_graph
            const wgRes = await client.query(
                `INSERT INTO workflow_graphs
                    (org_id, architecture_decision_set_id, version, status, graph_json)
                 VALUES ($1, $2, 1, 'delegated', $3)
                 RETURNING id`,
                [
                    orgId,
                    decisionSetId,
                    JSON.stringify({
                        nodes: phases.map((p, idx) => ({
                            id: `phase-${idx + 1}`,
                            name: p.name,
                            execution_hint: p.execution_hint || tpl.default_execution_hint,
                        })),
                        template_id: tpl.id,
                        template_name: tpl.name,
                    }),
                ]
            );
            const workflowGraphId = wgRes.rows[0].id as string;

            // 6. Cria architect_work_items (uma por fase)
            const workItemIds: string[] = [];
            for (let i = 0; i < phases.length; i++) {
                const phase = phases[i];
                const hint = phase.execution_hint && VALID_HINTS.includes(phase.execution_hint)
                    ? phase.execution_hint
                    : tpl.default_execution_hint;

                const wiRes = await client.query(
                    `INSERT INTO architect_work_items
                        (org_id, workflow_graph_id, node_id, item_type, title, description, execution_hint, status)
                     VALUES ($1, $2, $3, 'compliance_check', $4, $5, $6, 'pending')
                     RETURNING id`,
                    [
                        orgId,
                        workflowGraphId,
                        `phase-${i + 1}`,
                        `[${i + 1}/${phases.length}] ${phase.name}`,
                        phase.description ?? null,
                        hint,
                    ]
                );
                workItemIds.push(wiRes.rows[0].id as string);
            }

            await client.query('COMMIT');

            return reply.status(201).send({
                demand_case_id: demandCaseId,
                case_id: demandCaseId,
                problem_contract_id: contractId,
                decision_set_id: decisionSetId,
                workflow_graph_id: workflowGraphId,
                work_items_created: workItemIds.length,
                work_item_ids: workItemIds,
                template: { id: tpl.id, name: tpl.name },
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    });
}
