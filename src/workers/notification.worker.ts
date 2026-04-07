import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import axios from 'axios';
import crypto from 'crypto';
import { Pool } from 'pg';

/**
 * Notification Worker — Dispatches HITL alerts + governance events.
 *
 * Priority order:
 *  1. Per-org webhook_configs from DB (when pgPool is available)
 *  2. Legacy env vars: WEBHOOK_URL, SLACK_WEBHOOK_URL, SENDGRID_API_KEY
 */

export interface NotificationPayload {
    event: 'PENDING_APPROVAL' | 'APPROVAL_EXPIRED' | 'APPROVAL_GRANTED' | 'APPROVAL_REJECTED'
        | 'execution.success' | 'execution.violation' | 'approval.pending' | 'approval.granted'
        | 'approval.rejected' | 'exit.perimeter' | 'shield.critical_finding'
        | 'assistant.published' | 'review.completed' | 'exception.expiring';
    orgId: string;
    assistantId?: string;
    approvalId: string;
    reason: string;
    traceId?: string;
    expiresAt?: string;
    timestamp: string;
    metadata?: Record<string, any>;
}

// Retry delays in milliseconds (exponential: 1m, 5m, 30m, 2h)
const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const notificationQueue = new Queue('notifications', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any
});

function hmacSign(payload: object, secret: string): string {
    return crypto.createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');
}

export function initNotificationWorker(pgPool?: Pool) {
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    const worker = new Worker('notifications', async (job: Job<NotificationPayload>) => {
        const payload = job.data;
        const log = console;
        let sent = false;

        // ── 1. DB-based webhooks (per-org config) ──────────────────────────
        if (pgPool && payload.orgId) {
            const client = await pgPool.connect();
            try {
                await client.query(
                    `SELECT set_config('app.current_org_id', $1, false)`,
                    [payload.orgId]
                );
                // Normalize event name: PENDING_APPROVAL → approval.pending
                const eventNorm = payload.event.toLowerCase().replace(/_/g, '.');

                const webhooksRes = await client.query(
                    `SELECT id, url, secret, events FROM webhook_configs
                     WHERE org_id = $1 AND is_active = true
                       AND (events @> ARRAY[$2]::text[] OR array_length(events, 1) = 0)`,
                    [payload.orgId, eventNorm]
                );

                for (const wh of webhooksRes.rows) {
                    const deliveryId = crypto.randomUUID();
                    const deliveryPayload = { ...payload, delivery_id: deliveryId };
                    const signature = wh.secret ? hmacSign(deliveryPayload, wh.secret) : null;
                    const headers: Record<string, string> = {
                        'Content-Type': 'application/json',
                        'X-GovAI-Event': payload.event,
                        'X-GovAI-Delivery': deliveryId,
                        'X-GovAI-Timestamp': payload.timestamp,
                    };
                    if (signature) headers['X-GovAI-Signature'] = `sha256=${signature}`;

                    let status: 'success' | 'failed' | 'retrying' = 'failed';
                    let responseCode: number | null = null;
                    let responseBody: string | null = null;
                    let attempts = 1;
                    let nextRetryAt: Date | null = null;

                    try {
                        const resp = await axios.post(wh.url, deliveryPayload, { headers, timeout: 8000 });
                        status = 'success';
                        responseCode = resp.status;
                        responseBody = typeof resp.data === 'string' ? resp.data.slice(0, 512) : JSON.stringify(resp.data).slice(0, 512);
                        sent = true;
                        log.info({ webhookId: wh.id, deliveryId, event: payload.event }, 'Webhook delivered');
                    } catch (err: any) {
                        const existingAttempts = await client.query(
                            `SELECT attempts FROM webhook_deliveries WHERE id = $1`,
                            [deliveryId]
                        );
                        const prevAttempts = existingAttempts.rows.length > 0
                            ? existingAttempts.rows[0].attempts : 0;
                        attempts = prevAttempts + 1;

                        if (attempts < 4) {
                            status = 'retrying';
                            nextRetryAt = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]);
                        }
                        responseCode = err.response?.status ?? null;
                        responseBody = String(err.message).slice(0, 512);
                        log.warn({ webhookId: wh.id, deliveryId, attempts, error: err.message }, 'Webhook delivery failed');
                    }

                    await client.query(
                        `INSERT INTO webhook_deliveries
                         (id, org_id, webhook_id, event, payload, status, response_code, response_body, attempts, next_retry_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                         ON CONFLICT (id) DO UPDATE SET
                           status = EXCLUDED.status, response_code = EXCLUDED.response_code,
                           response_body = EXCLUDED.response_body, attempts = EXCLUDED.attempts,
                           next_retry_at = EXCLUDED.next_retry_at`,
                        [deliveryId, payload.orgId, wh.id, payload.event,
                         JSON.stringify(deliveryPayload), status, responseCode, responseBody,
                         attempts, nextRetryAt]
                    );
                }
            } catch (err: any) {
                log.warn({ error: err.message }, 'NotificationWorker: DB webhook dispatch failed');
            } finally {
                await client.query("SELECT set_config('app.current_org_id', '', false)").catch(() => {});
                client.release();
            }
        }

        // ── 2. Legacy env-var fallbacks ────────────────────────────────────

        // Generic Webhook (env var)
        if (process.env.WEBHOOK_URL) {
            try {
                await axios.post(process.env.WEBHOOK_URL, payload, {
                    headers: { 'Content-Type': 'application/json', 'X-GovAI-Event': payload.event, 'X-GovAI-Org': payload.orgId },
                    timeout: 5000,
                });
                sent = true;
                log.info({ approvalId: payload.approvalId }, 'Notification: Webhook dispatched');
            } catch (err: any) { log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: Webhook failed'); }
        }

        // SendGrid Email
        if (process.env.SENDGRID_API_KEY && process.env.NOTIFICATION_EMAIL) {
            try {
                await axios.post('https://api.sendgrid.com/v3/mail/send', {
                    personalizations: [{ to: [{ email: process.env.NOTIFICATION_EMAIL }] }],
                    from: { email: process.env.SENDGRID_FROM || 'govai@noreply.com', name: 'GovAI Platform' },
                    subject: `[GovAI] ${payload.event}: Ação requer atenção — ${payload.reason}`,
                    content: [{
                        type: 'text/html',
                        value: `
                            <h2>GovAI Platform — ${payload.event}</h2>
                            <p><strong>Motivo:</strong> ${payload.reason}</p>
                            <p><strong>Approval ID:</strong> ${payload.approvalId}</p>
                            <p><strong>Organização:</strong> ${payload.orgId}</p>
                            ${payload.expiresAt ? `<p><strong>Expira em:</strong> ${payload.expiresAt}</p>` : ''}
                            <p><strong>Timestamp:</strong> ${payload.timestamp}</p>
                            <hr>
                            <p>Acesse o painel administrativo para tomar uma ação.</p>
                        `
                    }],
                }, {
                    headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
                    timeout: 10000,
                });
                sent = true;
                log.info({ approvalId: payload.approvalId }, 'Notification: SendGrid email sent');
            } catch (err: any) { log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: SendGrid failed'); }
        }

        // Slack Webhook
        if (process.env.SLACK_WEBHOOK_URL) {
            try {
                await axios.post(process.env.SLACK_WEBHOOK_URL, {
                    text: `🛡️ *GovAI — ${payload.event}*`,
                    blocks: [
                        { type: 'header', text: { type: 'plain_text', text: `🛡️ ${payload.event}` } },
                        {
                            type: 'section', fields: [
                                { type: 'mrkdwn', text: `*Motivo:*\n${payload.reason}` },
                                { type: 'mrkdwn', text: `*Approval ID:*\n\`${payload.approvalId}\`` },
                                { type: 'mrkdwn', text: `*Organização:*\n${payload.orgId}` },
                                { type: 'mrkdwn', text: `*Expira:*\n${payload.expiresAt || 'N/A'}` },
                            ]
                        }
                    ]
                }, { timeout: 5000 });
                sent = true;
                log.info({ approvalId: payload.approvalId }, 'Notification: Slack message sent');
            } catch (err: any) { log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: Slack failed'); }
        }

        if (!sent) {
            log.warn(payload, 'Notification: No channels configured or all failed — logging payload');
        }

        return { success: true };
    }, { connection: connection as any });

    worker.on('failed', (job, err) => {
        console.error(`[NotificationWorker] Job ${job?.id} failed:`, err);
    });

    console.log("Notification Worker Initialized");
    return worker;
}
