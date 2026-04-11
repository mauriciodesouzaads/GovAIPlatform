/**
 * Skills Routes — FASE 5c
 *
 * CRUD para catalog_skills (skills catalogáveis reutilizáveis).
 * Inspirado em anthropics/skills (estrutura SKILL.md com instructions + resources).
 *
 * Regras:
 *   - is_system = true → criada por seed, não pode ser deletada;
 *     editar permite somente alterar instructions/resources/is_active.
 *   - is_system = false → custom criada via API, permite full edit/delete.
 *   - Todas as queries fazem set_config('app.current_org_id') antes (RLS).
 */

import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

interface SkillBody {
    name?: string;
    description?: string;
    category?: string;
    instructions?: string;
    resources?: Record<string, unknown>;
    tags?: string[];
    version?: string;
    is_active?: boolean;
}

export async function skillsRoutes(
    fastify: FastifyInstance,
    opts: { pgPool: Pool; requireRole: (roles: string[]) => any }
) {
    const { pgPool, requireRole } = opts;
    const auth      = requireRole(['admin', 'dpo', 'operator']);
    const authWrite = requireRole(['admin']);

    // ── GET /v1/admin/catalog/skills ──────────────────────────────────────────
    fastify.get('/v1/admin/catalog/skills', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const { category, tag } = (request.query ?? {}) as { category?: string; tag?: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const where: string[] = ['org_id = $1'];
            const params: any[] = [orgId];
            if (category) {
                params.push(category);
                where.push(`category = $${params.length}`);
            }
            if (tag) {
                params.push(tag);
                where.push(`$${params.length} = ANY(tags)`);
            }

            const result = await client.query(
                `SELECT id, name, description, category, instructions, resources, tags,
                        version, is_active, is_system, created_by, created_at, updated_at
                 FROM catalog_skills
                 WHERE ${where.join(' AND ')}
                 ORDER BY is_system DESC, name ASC`,
                params
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/:id ──────────────────────────────────────
    fastify.get('/v1/admin/catalog/skills/:id', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, name, description, category, instructions, resources, tags,
                        version, is_active, is_system, created_by, created_at, updated_at
                 FROM catalog_skills
                 WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (result.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/catalog/skills ─────────────────────────────────────────
    fastify.post('/v1/admin/catalog/skills', { preHandler: authWrite }, async (request: any, reply) => {
        const { userId, orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });

        const body = (request.body ?? {}) as SkillBody;

        if (!body.name || !body.instructions) {
            return reply.status(400).send({ error: 'name e instructions são obrigatórios.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO catalog_skills
                    (org_id, name, description, category, instructions, resources, tags, version, is_active, is_system, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
                 RETURNING id, name, description, category, instructions, resources, tags,
                           version, is_active, is_system, created_by, created_at, updated_at`,
                [
                    orgId,
                    body.name,
                    body.description ?? null,
                    body.category ?? null,
                    body.instructions,
                    JSON.stringify(body.resources ?? {}),
                    body.tags ?? [],
                    body.version ?? '1.0',
                    body.is_active ?? true,
                    userId ?? null,
                ]
            );
            return reply.status(201).send(result.rows[0]);
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Já existe uma skill com esse nome.' });
            }
            throw err;
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/catalog/skills/:id ──────────────────────────────────────
    fastify.put('/v1/admin/catalog/skills/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id }  = request.params as { id: string };
        const body    = (request.body ?? {}) as SkillBody;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            // Verifica se existe e se é system skill
            const existing = await client.query(
                `SELECT id, is_system FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            const isSystem = existing.rows[0].is_system as boolean;

            // System skills: somente instructions, resources e is_active editáveis
            const sets: string[] = [];
            const params: any[] = [];

            if (body.instructions !== undefined) {
                params.push(body.instructions);
                sets.push(`instructions = $${params.length}`);
            }
            if (body.resources !== undefined) {
                params.push(JSON.stringify(body.resources));
                sets.push(`resources = $${params.length}`);
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
                if (body.description !== undefined) {
                    params.push(body.description);
                    sets.push(`description = $${params.length}`);
                }
                if (body.category !== undefined) {
                    params.push(body.category);
                    sets.push(`category = $${params.length}`);
                }
                if (body.tags !== undefined) {
                    params.push(body.tags);
                    sets.push(`tags = $${params.length}`);
                }
                if (body.version !== undefined) {
                    params.push(body.version);
                    sets.push(`version = $${params.length}`);
                }
            }

            if (sets.length === 0) {
                return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });
            }

            params.push(id);
            params.push(orgId);
            const result = await client.query(
                `UPDATE catalog_skills
                 SET ${sets.join(', ')}
                 WHERE id = $${params.length - 1} AND org_id = $${params.length}
                 RETURNING id, name, description, category, instructions, resources, tags,
                           version, is_active, is_system, created_by, created_at, updated_at`,
                params
            );
            return reply.send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/catalog/skills/:id ───────────────────────────────────
    fastify.delete('/v1/admin/catalog/skills/:id', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                `SELECT is_system FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Skill não encontrada.' });
            }
            if (existing.rows[0].is_system) {
                return reply.status(403).send({ error: 'Skills do sistema não podem ser deletadas.' });
            }

            await client.query(
                `DELETE FROM catalog_skills WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/catalog/skills/assistants/:assistantId ──────────────────
    // Lista skills vinculadas a um assistente
    fastify.get('/v1/admin/catalog/skills/assistants/:assistantId', { preHandler: auth }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId } = request.params as { assistantId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT cs.id, cs.name, cs.description, cs.category, cs.tags,
                        cs.is_system, asb.is_active as binding_active, asb.created_at as bound_at
                 FROM assistant_skill_bindings asb
                 JOIN catalog_skills cs ON cs.id = asb.skill_id
                 WHERE asb.assistant_id = $1 AND asb.org_id = $2
                 ORDER BY cs.name ASC`,
                [assistantId, orgId]
            );
            return reply.send(result.rows);
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/catalog/skills/assistants/:assistantId/bindings ────────
    // Vincula uma skill a um assistente
    fastify.post('/v1/admin/catalog/skills/assistants/:assistantId/bindings', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId } = request.params as { assistantId: string };
        const { skillId } = (request.body ?? {}) as { skillId?: string };

        if (!skillId) {
            return reply.status(400).send({ error: 'skillId é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO assistant_skill_bindings (org_id, assistant_id, skill_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (assistant_id, skill_id) DO UPDATE SET is_active = true
                 RETURNING id, assistant_id, skill_id, is_active, created_at`,
                [orgId, assistantId, skillId]
            );
            return reply.status(201).send(result.rows[0]);
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/catalog/skills/assistants/:assistantId/bindings/:skillId ─
    fastify.delete('/v1/admin/catalog/skills/assistants/:assistantId/bindings/:skillId', { preHandler: authWrite }, async (request: any, reply) => {
        const { orgId } = request.user ?? {};
        if (!orgId) return reply.status(401).send({ error: 'orgId ausente no token.' });
        const { assistantId, skillId } = request.params as { assistantId: string; skillId: string };

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            await client.query(
                `DELETE FROM assistant_skill_bindings
                 WHERE assistant_id = $1 AND skill_id = $2 AND org_id = $3`,
                [assistantId, skillId, orgId]
            );
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });
}
