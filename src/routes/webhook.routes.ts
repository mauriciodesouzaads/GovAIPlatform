import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { notificationQueue } from '../workers/notification.worker';

/**
 * Webhook Routes — CRUD for per-org webhook configurations + delivery log (FASE-C1).
 */
export async function webhookRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;

    // ── GET /v1/admin/webhooks — list org's webhooks ─────────────────────────
    app.get('/v1/admin/webhooks', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, name, url, events, is_active, created_at, updated_at
                 FROM webhook_configs
                 WHERE org_id = $1
                 ORDER BY created_at DESC`,
                [orgId]
            );
            return reply.send({ total: res.rowCount, webhooks: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching webhooks');
            return reply.status(500).send({ error: 'Erro ao buscar webhooks.' });
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/webhooks — create webhook config ──────────────────────
    app.post('/v1/admin/webhooks', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { name, url, secret, events, is_active = true } =
            request.body as { name: string; url: string; secret?: string; events?: string[]; is_active?: boolean };

        if (!name || name.trim().length === 0) return reply.status(400).send({ error: "Campo 'name' obrigatório." });
        if (!url  || !url.startsWith('http')) return reply.status(400).send({ error: "Campo 'url' deve ser uma URL válida." });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `INSERT INTO webhook_configs (org_id, name, url, secret, events, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, url, events, is_active, created_at`,
                [orgId, name.trim(), url.trim(), secret ?? null, events ?? [], is_active]
            );
            return reply.status(201).send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error creating webhook');
            return reply.status(500).send({ error: 'Erro ao criar webhook.' });
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/webhooks/:id — update webhook config ───────────────────
    app.put('/v1/admin/webhooks/:id', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };
        const { name, url, secret, events, is_active } =
            request.body as { name?: string; url?: string; secret?: string; events?: string[]; is_active?: boolean };

        const sets: string[] = ['updated_at = now()'];
        const params: unknown[] = [id, orgId];

        if (name      !== undefined) { params.push(name.trim());  sets.push(`name = $${params.length}`); }
        if (url       !== undefined) { params.push(url.trim());   sets.push(`url = $${params.length}`); }
        if (secret    !== undefined) { params.push(secret);       sets.push(`secret = $${params.length}`); }
        if (events    !== undefined) { params.push(events);       sets.push(`events = $${params.length}`); }
        if (is_active !== undefined) { params.push(is_active);    sets.push(`is_active = $${params.length}`); }

        if (sets.length === 1) return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `UPDATE webhook_configs SET ${sets.join(', ')}
                 WHERE id = $1 AND org_id = $2
                 RETURNING id, name, url, events, is_active, updated_at`,
                params
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Webhook não encontrado.' });
            return reply.send(res.rows[0]);
        } catch (error) {
            app.log.error(error, 'Error updating webhook');
            return reply.status(500).send({ error: 'Erro ao atualizar webhook.' });
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/webhooks/:id — soft-delete (deactivate) ────────────
    app.delete('/v1/admin/webhooks/:id', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `UPDATE webhook_configs SET is_active = false, updated_at = now()
                 WHERE id = $1 AND org_id = $2
                 RETURNING id, is_active`,
                [id, orgId]
            );
            if (res.rows.length === 0) return reply.status(404).send({ error: 'Webhook não encontrado.' });
            return reply.send({ success: true, webhook: res.rows[0] });
        } catch (error) {
            app.log.error(error, 'Error deactivating webhook');
            return reply.status(500).send({ error: 'Erro ao desativar webhook.' });
        } finally {
            client.release();
        }
    });

    // ── GET /v1/admin/webhooks/:id/deliveries — delivery log ────────────────
    app.get('/v1/admin/webhooks/:id/deliveries', { preHandler: requireRole(['admin', 'operator']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { id } = request.params as { id: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
            const res = await client.query(
                `SELECT id, event, status, response_code, attempts, next_retry_at, created_at
                 FROM webhook_deliveries
                 WHERE webhook_id = $1 AND org_id = $2
                 ORDER BY created_at DESC
                 LIMIT 20`,
                [id, orgId]
            );
            return reply.send({ total: res.rowCount, deliveries: res.rows });
        } catch (error) {
            app.log.error(error, 'Error fetching webhook deliveries');
            return reply.status(500).send({ error: 'Erro ao buscar entregas.' });
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/webhooks/:webhookId/deliveries/:deliveryId/retry ──────
    app.post('/v1/admin/webhooks/:webhookId/deliveries/:deliveryId/retry', { preHandler: requireRole(['admin']) }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        if (!orgId) return reply.status(401).send({ error: "Header 'x-org-id' é obrigatório." });

        const { webhookId, deliveryId } = request.params as { webhookId: string; deliveryId: string };

        const client = await pgPool.connect();
        try {
            await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

            // Fetch delivery + webhook data
            const res = await client.query(
                `SELECT d.id, d.event, d.payload, d.status,
                        wc.url, wc.secret
                 FROM webhook_deliveries d
                 JOIN webhook_configs wc ON wc.id = d.webhook_id
                 WHERE d.id = $1 AND d.webhook_id = $2 AND d.org_id = $3`,
                [deliveryId, webhookId, orgId]
            );

            if (res.rows.length === 0) {
                return reply.status(404).send({ error: 'Entrega não encontrada.' });
            }

            const delivery = res.rows[0];

            // Re-queue the original payload
            const originalPayload = typeof delivery.payload === 'string'
                ? JSON.parse(delivery.payload) : delivery.payload;

            await notificationQueue.add(`retry:${delivery.event}`, {
                ...originalPayload,
                event: delivery.event,
                orgId,
                approvalId: originalPayload.approvalId ?? deliveryId,
                timestamp: new Date().toISOString(),
            });

            // Mark delivery as retrying
            await client.query(
                `UPDATE webhook_deliveries SET status = 'retrying', next_retry_at = NOW() + interval '30 seconds' WHERE id = $1`,
                [deliveryId]
            );

            return reply.send({ success: true, queued: true });
        } catch (error) {
            app.log.error(error, 'Error retrying webhook delivery');
            return reply.status(500).send({ error: 'Erro ao reenviar entrega.' });
        } finally {
            client.release();
        }
    });
}
