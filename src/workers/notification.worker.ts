import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import axios from 'axios';

/**
 * Notification Worker — Dispatches HITL alerts via configured channels asynchronously.
 */

export interface NotificationPayload {
    event: 'PENDING_APPROVAL' | 'APPROVAL_EXPIRED' | 'APPROVAL_GRANTED' | 'APPROVAL_REJECTED';
    orgId: string;
    assistantId?: string;
    approvalId: string;
    reason: string;
    traceId?: string;
    expiresAt?: string;
    timestamp: string;
    metadata?: Record<string, any>;
}

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const notificationQueue = new Queue('notifications', {
    connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) as any
});

export function initNotificationWorker() {
    const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

    const worker = new Worker('notifications', async (job: Job<NotificationPayload>) => {
        const payload = job.data;
        const log = console;

        let sent = false;

        // 1. Generic Webhook
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

        // 2. SendGrid Email
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

        // 3. Slack Webhook
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

        // 4. Fallback Log
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
