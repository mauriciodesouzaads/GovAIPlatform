import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { notificationQueue } from '../workers/notification.worker';

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

            // Dispatch policy.updated notification
            await notificationQueue.add('policy.updated', {
                event: 'policy.updated' as any,
                orgId,
                approvalId: res.rows[0].id,
                reason: `Política "${cur.rows[0].name}" atualizada para v${newVersion}`,
                timestamp: new Date().toISOString(),
                metadata: { policyId: res.rows[0].id, name: cur.rows[0].name, version: newVersion },
            }).catch(() => {});

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

    // GET /v1/admin/policies/:id/diff/:otherId — JSON rules diff between two policy versions
    app.get('/v1/admin/policies/:id/diff/:otherId', { preHandler: requireRole(['admin', 'dpo', 'compliance', 'auditor']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id, otherId } = request.params as { id: string; otherId: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const [r1, r2] = await Promise.all([
                client.query(`SELECT id, name, version, rules_jsonb, created_at FROM policy_versions WHERE id = $1 AND org_id = $2`, [id, orgId]),
                client.query(`SELECT id, name, version, rules_jsonb, created_at FROM policy_versions WHERE id = $1 AND org_id = $2`, [otherId, orgId]),
            ]);

            if (r1.rowCount === 0 || r2.rowCount === 0) {
                return reply.status(404).send({ error: 'Uma ou ambas as políticas não foram encontradas.' });
            }

            const pa = r1.rows[0];
            const pb = r2.rows[0];
            const rulesA: Record<string, unknown> = pa.rules_jsonb ?? {};
            const rulesB: Record<string, unknown> = pb.rules_jsonb ?? {};
            const allKeys = new Set([...Object.keys(rulesA), ...Object.keys(rulesB)]);

            const changes = [...allKeys].map(key => {
                if (!(key in rulesA)) return { key, before: undefined, after: rulesB[key], type: 'added' };
                if (!(key in rulesB)) return { key, before: rulesA[key], after: undefined, type: 'removed' };
                const same = JSON.stringify(rulesA[key]) === JSON.stringify(rulesB[key]);
                return { key, before: rulesA[key], after: rulesB[key], type: same ? 'unchanged' : 'changed' };
            });

            return reply.send({
                from: { id: pa.id, name: pa.name, version: pa.version, created_at: pa.created_at },
                to:   { id: pb.id, name: pb.name, version: pb.version, created_at: pb.created_at },
                changes,
                has_changes: changes.some(c => c.type !== 'unchanged'),
            });
        } catch (error) {
            app.log.error(error, 'Error computing policy diff');
            return reply.status(500).send({ error: 'Erro ao calcular diff de políticas.' });
        } finally {
            client.release();
        }
    });
}
