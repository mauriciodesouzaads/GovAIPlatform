import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import axios from 'axios';
import {
    NOTIFICATION_EVENTS,
    buildSlackPayload,
    buildTeamsPayload,
    buildPreviewPayload,
    NotificationEvent,
    EventPayload,
} from '../lib/notification-templates';

export async function notificationChannelsRoutes(
    app: FastifyInstance,
    opts: { pgPool: Pool; requireRole: any }
) {
    const { pgPool, requireRole } = opts;
    const auth      = requireRole(['admin', 'dpo']);
    const authAdmin = requireRole(['admin']);

    // ── GET /v1/admin/notification-channels/events ────────────────────────────
    // Returns the full event catalogue — used to populate the event checkboxes UI.
    app.get('/v1/admin/notification-channels/events', { preHandler: auth }, async (_request, _reply) => {
        return NOTIFICATION_EVENTS.map(e => ({
            value:    e.value,
            label:    e.label,
            severity: e.severity,
            category: e.category,
        }));
    });

    // ── GET /v1/admin/notification-channels/preview ───────────────────────────
    // Returns a rendered payload preview for the UI.
    // Query params: ?provider=slack|teams&event=<NotificationEvent>
    app.get('/v1/admin/notification-channels/preview', { preHandler: auth }, async (request, reply) => {
        const { provider, event } = request.query as { provider?: string; event?: string };
        if (!provider || !event) {
            return reply.status(400).send({ error: 'provider e event são obrigatórios.' });
        }
        const validEvent = NOTIFICATION_EVENTS.find(e => e.value === event);
        if (!validEvent) {
            return reply.status(400).send({ error: `Evento inválido: ${event}` });
        }
        if (!['slack', 'teams'].includes(provider)) {
            return reply.status(400).send({ error: 'provider deve ser slack ou teams.' });
        }
        return buildPreviewPayload(provider, event as NotificationEvent);
    });

    // ── GET /v1/admin/notification-channels ───────────────────────────────────
    // Returns all notification channels for the org.
    app.get('/v1/admin/notification-channels', { preHandler: auth }, async (request, _reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `SELECT id, name, provider, config, events, is_active, created_at, updated_at
                 FROM notification_channels
                 WHERE org_id = $1
                 ORDER BY created_at ASC`,
                [orgId]
            );
            return result.rows;
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/notification-channels ──────────────────────────────────
    // Creates a new notification channel.
    app.post('/v1/admin/notification-channels', { preHandler: authAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const body  = request.body as {
            name:      string;
            provider:  'slack' | 'teams' | 'email';
            config:    Record<string, unknown>;
            events?:   string[];
            is_active?: boolean;
        };

        if (!body.name || !body.provider || !body.config) {
            return reply.status(400).send({ error: 'name, provider e config são obrigatórios.' });
        }
        if (!['slack', 'teams', 'email'].includes(body.provider)) {
            return reply.status(400).send({ error: 'provider deve ser slack, teams ou email.' });
        }
        if ((body.provider === 'slack' || body.provider === 'teams') && !body.config.webhook_url) {
            return reply.status(400).send({ error: 'config.webhook_url é obrigatório para Slack e Teams.' });
        }
        if (body.provider === 'email') {
            const recps = body.config.recipients as unknown[];
            if (!Array.isArray(recps) || recps.length === 0) {
                return reply.status(400).send({ error: 'config.recipients é obrigatório para Email.' });
            }
        }

        const validEventValues = NOTIFICATION_EVENTS.map(e => e.value);
        const events = (body.events ?? []).filter(ev => validEventValues.includes(ev as NotificationEvent));

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                `INSERT INTO notification_channels
                    (org_id, name, provider, config, events, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, provider, config, events, is_active, created_at, updated_at`,
                [orgId, body.name, body.provider, JSON.stringify(body.config),
                 events, body.is_active ?? true]
            );
            return reply.status(201).send(result.rows[0]);
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Já existe um canal com esse nome nesta organização.' });
            }
            throw err;
        } finally {
            client.release();
        }
    });

    // ── PUT /v1/admin/notification-channels/:id ───────────────────────────────
    // Updates an existing notification channel.
    app.put('/v1/admin/notification-channels/:id', { preHandler: authAdmin }, async (request, reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const body   = request.body as {
            name?:      string;
            provider?:  'slack' | 'teams' | 'email';
            config?:    Record<string, unknown>;
            events?:    string[];
            is_active?: boolean;
        };

        const validEventValues = NOTIFICATION_EVENTS.map(e => e.value);
        const eventsFiltered = body.events !== undefined
            ? body.events.filter(ev => validEventValues.includes(ev as NotificationEvent))
            : undefined;

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

            const existing = await client.query(
                'SELECT id FROM notification_channels WHERE id = $1 AND org_id = $2',
                [id, orgId]
            );
            if (existing.rows.length === 0) {
                return reply.status(404).send({ error: 'Canal de notificação não encontrado.' });
            }

            const result = await client.query(
                `UPDATE notification_channels
                 SET name      = COALESCE($3, name),
                     provider  = COALESCE($4, provider),
                     config    = COALESCE($5, config),
                     events    = COALESCE($6, events),
                     is_active = COALESCE($7, is_active)
                 WHERE id = $1 AND org_id = $2
                 RETURNING id, name, provider, config, events, is_active, created_at, updated_at`,
                [
                    id, orgId,
                    body.name ?? null,
                    body.provider ?? null,
                    body.config !== undefined ? JSON.stringify(body.config) : null,
                    eventsFiltered ?? null,
                    body.is_active ?? null,
                ]
            );
            return result.rows[0];
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'Já existe um canal com esse nome nesta organização.' });
            }
            throw err;
        } finally {
            client.release();
        }
    });

    // ── DELETE /v1/admin/notification-channels/:id ────────────────────────────
    // Deletes a notification channel.
    app.delete('/v1/admin/notification-channels/:id', { preHandler: authAdmin }, async (request, reply) => {
        const orgId  = request.headers['x-org-id'] as string;
        const { id } = request.params as { id: string };
        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const result = await client.query(
                'DELETE FROM notification_channels WHERE id = $1 AND org_id = $2 RETURNING id',
                [id, orgId]
            );
            if (result.rowCount === 0) {
                return reply.status(404).send({ error: 'Canal de notificação não encontrado.' });
            }
            return reply.status(204).send();
        } finally {
            client.release();
        }
    });

    // ── POST /v1/admin/notification-channels/test ─────────────────────────────
    // Sends a test notification to the specified channel.
    // Body: { channel_id: string; event?: NotificationEvent }
    app.post('/v1/admin/notification-channels/test', { preHandler: authAdmin }, async (request, reply) => {
        const orgId = request.headers['x-org-id'] as string;
        const body  = request.body as { channel_id: string; event?: string };

        if (!body.channel_id) {
            return reply.status(400).send({ error: 'channel_id é obrigatório.' });
        }

        const client = await pgPool.connect();
        try {
            await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
            const chRes = await client.query(
                'SELECT * FROM notification_channels WHERE id = $1 AND org_id = $2',
                [body.channel_id, orgId]
            );
            if (chRes.rows.length === 0) {
                return reply.status(404).send({ error: 'Canal de notificação não encontrado.' });
            }
            const channel = chRes.rows[0];
            if (!channel.is_active) {
                return reply.status(400).send({ error: 'Canal está inativo.' });
            }

            const testEvent: NotificationEvent = (body.event as NotificationEvent) || 'policy.violation';
            const orgRes = await client.query(
                'SELECT name FROM organizations WHERE id = $1 LIMIT 1',
                [orgId]
            );
            const orgName = orgRes.rows[0]?.name ?? 'GovAI';

            const eventPayload: EventPayload = {
                event:          testEvent,
                org_name:       orgName,
                assistant_name: 'Assistente de Teste',
                assistant_id:   '00000000-0000-0000-0000-000000000001',
                user_email:     'test@govai.com',
                details:        'Mensagem de teste enviada pelo painel de administração.',
                timestamp:      new Date().toISOString(),
                trace_id:       `test-${Date.now()}`,
                base_url:       process.env.ADMIN_UI_ORIGIN || 'http://localhost:3001',
            };

            if (channel.provider === 'slack' || channel.provider === 'teams') {
                const webhookUrl = channel.config?.webhook_url as string;
                if (!webhookUrl) {
                    return reply.status(400).send({ error: 'webhook_url não configurado no canal.' });
                }
                const notifPayload = channel.provider === 'slack'
                    ? buildSlackPayload(eventPayload)
                    : buildTeamsPayload(eventPayload);

                try {
                    await axios.post(webhookUrl, notifPayload, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 8000,
                    });
                    return reply.send({ success: true, message: 'Notificação de teste enviada com sucesso.' });
                } catch (err: any) {
                    return reply.status(502).send({
                        success: false,
                        error: 'Falha ao enviar para o webhook.',
                        details: err.response?.status
                            ? `HTTP ${err.response.status}: ${String(err.response.data).slice(0, 200)}`
                            : err.message,
                    });
                }
            }

            if (channel.provider === 'email') {
                // Email: just validate config and return success (SMTP not wired here)
                const recipients = channel.config?.recipients as string[];
                if (!Array.isArray(recipients) || recipients.length === 0) {
                    return reply.status(400).send({ error: 'Nenhum destinatário configurado.' });
                }
                return reply.send({
                    success: true,
                    message: `Email de teste seria enviado para: ${recipients.join(', ')} (integração SMTP não configurada).`,
                });
            }

            return reply.status(400).send({ error: 'Provedor não suportado.' });
        } finally {
            client.release();
        }
    });
}
