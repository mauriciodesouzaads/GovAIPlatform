import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';

/**
 * Settings Routes — org config, review tracks CRUD, retention policy.
 */
export async function settingsRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const ADMIN_ONLY = requireRole(['admin', 'platform_admin']);

    // ── GET /v1/admin/settings/organization ──────────────────────────────────
    app.get('/v1/admin/settings/organization', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, name, COALESCE(hitl_timeout_hours, 4) AS hitl_timeout_hours
                 FROM organizations WHERE id = $1`,
                [orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Organização não encontrada.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error fetching org settings');
            return reply.status(500).send({ error: 'Erro ao buscar configurações da organização.' });
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/settings/organization ──────────────────────────────────
    app.put('/v1/admin/settings/organization', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { hitl_timeout_hours } = request.body as { hitl_timeout_hours?: number };
        if (hitl_timeout_hours === undefined || typeof hitl_timeout_hours !== 'number') {
            return reply.status(400).send({ error: "Campo 'hitl_timeout_hours' obrigatório (number)." });
        }
        if (hitl_timeout_hours < 1 || hitl_timeout_hours > 168) {
            return reply.status(400).send({ error: "hitl_timeout_hours deve estar entre 1 e 168." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `UPDATE organizations SET hitl_timeout_hours = $1 WHERE id = $2
                 RETURNING id, name, hitl_timeout_hours`,
                [hitl_timeout_hours, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Organização não encontrada.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating org settings');
            return reply.status(500).send({ error: 'Erro ao atualizar configurações da organização.' });
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/settings/review-tracks ─────────────────────────────────
    app.get('/v1/admin/settings/review-tracks', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, name, slug, description, sla_hours, is_required, is_active, sort_order, created_at, updated_at
                 FROM review_tracks
                 WHERE org_id = $1 AND deleted_at IS NULL
                 ORDER BY sort_order, name`,
                [orgId]
            );
            return reply.send(res.rows);
        } catch (error) {
            app.log.error(error, 'Error listing review tracks');
            return reply.status(500).send({ error: 'Erro ao listar trilhas de revisão.' });
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/settings/review-tracks ────────────────────────────────
    app.post('/v1/admin/settings/review-tracks', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const body = request.body as { name?: string; description?: string; sla_hours?: number; is_required?: boolean };
        const { name, description, sla_hours, is_required = true } = body;

        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return reply.status(400).send({ error: "Campo 'name' deve ter pelo menos 2 caracteres." });
        }
        if (sla_hours === undefined || typeof sla_hours !== 'number' || sla_hours < 1 || sla_hours > 720) {
            return reply.status(400).send({ error: "Campo 'sla_hours' deve ser entre 1 e 720." });
        }

        // Generate slug from name: lowercase, spaces → hyphens, remove accents
        const slug = name.trim()
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            const maxOrder = await client.query(
                `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
                 FROM review_tracks WHERE org_id = $1 AND deleted_at IS NULL`,
                [orgId]
            );
            const sortOrder = maxOrder.rows[0].next_order;

            const res = await client.query(
                `INSERT INTO review_tracks (org_id, name, slug, description, sla_hours, is_required, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id, name, slug, description, sla_hours, is_required, is_active, sort_order, created_at`,
                [orgId, name.trim(), slug, description ?? null, sla_hours, is_required, sortOrder]
            );
            return reply.status(201).send(res.rows[0]);
        } catch (error: any) {
            if (error.code === '23505') {
                return reply.status(409).send({ error: 'Já existe uma trilha com esse nome nesta organização.' });
            }
            app.log.error(error, 'Error creating review track');
            return reply.status(500).send({ error: 'Erro ao criar trilha de revisão.' });
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/settings/review-tracks/:id ─────────────────────────────
    app.put('/v1/admin/settings/review-tracks/:id', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };

        const body = request.body as { name?: string; description?: string; sla_hours?: number; is_required?: boolean; sort_order?: number };
        const { name, description, sla_hours, is_required, sort_order } = body;

        if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2)) {
            return reply.status(400).send({ error: "Campo 'name' deve ter pelo menos 2 caracteres." });
        }
        if (sla_hours !== undefined && (typeof sla_hours !== 'number' || sla_hours < 1 || sla_hours > 720)) {
            return reply.status(400).send({ error: "Campo 'sla_hours' deve ser entre 1 e 720." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Check for pending review decisions
            const pendingCheck = await client.query(
                `SELECT COUNT(*) AS cnt FROM review_decisions
                 WHERE track_id = $1 AND org_id = $2 AND decision = 'pending'`,
                [id, orgId]
            );
            if (parseInt(pendingCheck.rows[0].cnt) > 0) {
                return reply.status(409).send({ error: 'Existem revisões pendentes nesta trilha. Aguarde a conclusão antes de editar.' });
            }

            const sets: string[] = ['updated_at = NOW()'];
            const params: unknown[] = [id, orgId];

            if (name        !== undefined) { params.push(name.trim());  sets.push(`name = $${params.length}`); }
            if (description !== undefined) { params.push(description);  sets.push(`description = $${params.length}`); }
            if (sla_hours   !== undefined) { params.push(sla_hours);    sets.push(`sla_hours = $${params.length}`); }
            if (is_required !== undefined) { params.push(is_required);  sets.push(`is_required = $${params.length}`); }
            if (sort_order  !== undefined) { params.push(sort_order);   sets.push(`sort_order = $${params.length}`); }

            if (sets.length === 1) return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });

            const res = await client.query(
                `UPDATE review_tracks SET ${sets.join(', ')}
                 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
                 RETURNING id, name, slug, description, sla_hours, is_required, is_active, sort_order, updated_at`,
                params
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Trilha não encontrada.' });
            return reply.send(res.rows[0]);
        } catch (error: any) {
            if (error.code === '23505') {
                return reply.status(409).send({ error: 'Já existe uma trilha com esse nome nesta organização.' });
            }
            app.log.error(error, 'Error updating review track');
            return reply.status(500).send({ error: 'Erro ao atualizar trilha de revisão.' });
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/settings/review-tracks/:id ──────────────────────────
    app.delete('/v1/admin/settings/review-tracks/:id', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Block if pending decisions
            const pendingCheck = await client.query(
                `SELECT COUNT(*) AS cnt FROM review_decisions
                 WHERE track_id = $1 AND org_id = $2 AND decision = 'pending'`,
                [id, orgId]
            );
            if (parseInt(pendingCheck.rows[0].cnt) > 0) {
                return reply.status(409).send({ error: 'Existem revisões pendentes nesta trilha.' });
            }

            // Block if it's the last active track
            const activeCount = await client.query(
                `SELECT COUNT(*) AS cnt FROM review_tracks
                 WHERE org_id = $1 AND deleted_at IS NULL AND is_active = true AND id != $2`,
                [orgId, id]
            );
            if (parseInt(activeCount.rows[0].cnt) === 0) {
                return reply.status(422).send({ error: 'Pelo menos uma trilha deve estar ativa.' });
            }

            const res = await client.query(
                `UPDATE review_tracks SET deleted_at = NOW(), is_active = false, updated_at = NOW()
                 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
                 RETURNING id, name`,
                [id, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Trilha não encontrada.' });
            return reply.send({ success: true, deleted: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error deleting review track');
            return reply.status(500).send({ error: 'Erro ao remover trilha de revisão.' });
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/settings/review-tracks/reorder ───────────────────────
    app.post('/v1/admin/settings/review-tracks/reorder', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { track_ids } = request.body as { track_ids?: string[] };
        if (!Array.isArray(track_ids) || track_ids.length === 0) {
            return reply.status(400).send({ error: "Campo 'track_ids' deve ser um array não-vazio." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            await client.query('BEGIN');
            for (let i = 0; i < track_ids.length; i++) {
                await client.query(
                    `UPDATE review_tracks SET sort_order = $1, updated_at = NOW()
                     WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL`,
                    [i + 1, track_ids[i], orgId]
                );
            }
            await client.query('COMMIT');
            return reply.send({ success: true });
        } catch (error) {
            await client.query('ROLLBACK');
            app.log.error(error, 'Error reordering tracks');
            return reply.status(500).send({ error: 'Erro ao reordenar trilhas.' });
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/settings/retention ─────────────────────────────────────
    app.get('/v1/admin/settings/retention', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT audit_log_retention_days, archive_enabled, last_archive_run_at, last_archive_count
                 FROM org_retention_config WHERE org_id = $1`,
                [orgId]
            );
            if (res.rows.length === 0) {
                return reply.send({ audit_log_retention_days: 365, archive_enabled: false, last_archive_run_at: null, last_archive_count: 0 });
            }
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error fetching retention config');
            return reply.status(500).send({ error: 'Erro ao buscar configuração de retenção.' });
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/settings/retention ─────────────────────────────────────
    app.put('/v1/admin/settings/retention', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { audit_log_retention_days, archive_enabled } = request.body as {
            audit_log_retention_days?: number;
            archive_enabled?: boolean;
        };

        if (audit_log_retention_days !== undefined) {
            if (typeof audit_log_retention_days !== 'number' || audit_log_retention_days < 90 || audit_log_retention_days > 2555) {
                return reply.status(400).send({ error: "audit_log_retention_days deve estar entre 90 e 2555." });
            }
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `INSERT INTO org_retention_config (org_id, audit_log_retention_days, archive_enabled)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (org_id) DO UPDATE SET
                   audit_log_retention_days = EXCLUDED.audit_log_retention_days,
                   archive_enabled = EXCLUDED.archive_enabled,
                   updated_at = NOW()
                 RETURNING audit_log_retention_days, archive_enabled, last_archive_run_at, last_archive_count`,
                [orgId, audit_log_retention_days ?? 365, archive_enabled ?? false]
            );
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating retention config');
            return reply.status(500).send({ error: 'Erro ao salvar configuração de retenção.' });
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/settings/retention/preview ──────────────────────────────
    app.get('/v1/admin/settings/retention/preview', { preHandler: ADMIN_ONLY }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });
        const { days } = request.query as { days?: string };
        const retentionDays = parseInt(days ?? '365', 10);
        if (isNaN(retentionDays) || retentionDays < 90) {
            return reply.status(400).send({ error: "Parâmetro 'days' inválido (mínimo 90)." });
        }

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT COUNT(*) AS count
                 FROM audit_logs_partitioned
                 WHERE org_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL`,
                [orgId, retentionDays.toString()]
            );
            return reply.send({ count: parseInt(res.rows[0].count, 10), retention_days: retentionDays });
        } catch (error) {
            app.log.error(error, 'Error fetching retention preview');
            return reply.status(500).send({ error: 'Erro ao calcular preview de retenção.' });
        } finally {
            client.release();
        }
    });
}
