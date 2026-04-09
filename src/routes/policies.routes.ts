import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

export async function policiesRoutes(app: FastifyInstance, opts: { pgPool: Pool; requireRole: any }) {
    const { pgPool, requireRole } = opts;

    // GET /v1/admin/policies — latest version of each policy for org
    app.get('/v1/admin/policies', { preHandler: requireRole(['admin', 'dpo', 'compliance', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(`
                SELECT DISTINCT ON (name) id, org_id, name, rules_jsonb, version, created_at
                FROM policy_versions
                WHERE org_id = $1
                ORDER BY name, version DESC
            `, [orgId]);
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, 'Error listing policies');
            return reply.status(500).send({ error: 'Erro ao listar políticas.' });
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/policies/:id — single policy
    app.get('/v1/admin/policies/:id', { preHandler: requireRole(['admin', 'dpo', 'compliance', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, org_id, name, rules_jsonb, version, created_at FROM policy_versions WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Policy não encontrada.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error fetching policy');
            return reply.status(500).send({ error: 'Erro ao buscar política.' });
        } finally {
            client.release();
        }
    });

    // POST /v1/admin/policies — create new policy at version 1
    app.post('/v1/admin/policies', { preHandler: requireRole(['admin', 'dpo', 'compliance']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const body = request.body as any;
        const { name, rules_jsonb } = body ?? {};

        if (!name || typeof name !== 'string' || name.trim().length < 3) {
            return reply.status(400).send({ error: 'name deve ter pelo menos 3 caracteres.' });
        }
        if (!rules_jsonb || typeof rules_jsonb !== 'object') {
            return reply.status(400).send({ error: 'rules_jsonb é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `INSERT INTO policy_versions (org_id, name, rules_jsonb, version) VALUES ($1, $2, $3, 1) RETURNING *`,
                [orgId, name.trim(), JSON.stringify(rules_jsonb)]
            );
            return reply.status(201).send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error creating policy');
            return reply.status(500).send({ error: 'Erro ao criar política.' });
        } finally {
            client.release();
        }
    });

    // PUT /v1/admin/policies/:id — immutable versioning: creates new row with version+1
    app.put('/v1/admin/policies/:id', { preHandler: requireRole(['admin', 'dpo', 'compliance']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };
        const body = request.body as any;
        const { rules_jsonb } = body ?? {};

        if (!rules_jsonb || typeof rules_jsonb !== 'object') {
            return reply.status(400).send({ error: 'rules_jsonb é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Step 1: read current version
            const cur = await client.query(
                `SELECT name, version FROM policy_versions WHERE id = $1 AND org_id = $2`,
                [id, orgId]
            );
            if (cur.rows.length === 0) return reply.status(404).send({ error: 'Policy não encontrada.' });

            // Find latest version for this name (in case we're editing from history)
            const latest = await client.query(
                `SELECT MAX(version) as max_version FROM policy_versions WHERE org_id = $1 AND name = $2`,
                [orgId, cur.rows[0].name]
            );
            const newVersion = Number(latest.rows[0].max_version) + 1;

            // Step 2: insert new version
            const res = await client.query(
                `INSERT INTO policy_versions (org_id, name, rules_jsonb, version) VALUES ($1, $2, $3, $4) RETURNING *`,
                [orgId, cur.rows[0].name, JSON.stringify(rules_jsonb), newVersion]
            );
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating policy');
            return reply.status(500).send({ error: 'Erro ao salvar nova versão da política.' });
        } finally {
            client.release();
        }
    });

    // GET /v1/admin/policies/:id/history — all versions of the policy by name
    app.get('/v1/admin/policies/:id/history', { preHandler: requireRole(['admin', 'dpo', 'compliance', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(`
                SELECT id, version, rules_jsonb, created_at
                FROM policy_versions
                WHERE org_id = $1 AND name = (
                    SELECT name FROM policy_versions WHERE id = $2 AND org_id = $1
                )
                ORDER BY version DESC
            `, [orgId, id]);
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, 'Error fetching policy history');
            return reply.status(500).send({ error: 'Erro ao buscar histórico da política.' });
        } finally {
            client.release();
        }
    });
}
