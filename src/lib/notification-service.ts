import axios from 'axios';

/**
 * Notification Service — Dispatches HITL alerts via configured channels.
 * 
 * Supports:
 * - Webhook (generic HTTP POST) via WEBHOOK_URL
 * - SendGrid email via SENDGRID_API_KEY + NOTIFICATION_EMAIL
 * - Slack via SLACK_WEBHOOK_URL
 * - Fallback: structured logging
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

interface NotificationResult {
    channel: string;
    success: boolean;
    error?: string;
}

/**
 * Dispatch notification to all configured channels (non-blocking).
 * Failures on individual channels don't affect others.
 */
export async function dispatchNotification(
    payload: NotificationPayload,
    logger?: { info: Function; warn: Function; error: Function }
): Promise<NotificationResult[]> {
    const results: NotificationResult[] = [];
    const log = logger || console;

    // 1. Generic Webhook
    if (process.env.WEBHOOK_URL) {
        try {
            await axios.post(process.env.WEBHOOK_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-GovAI-Event': payload.event,
                    'X-GovAI-Org': payload.orgId,
                },
                timeout: 5000,
            });
            results.push({ channel: 'webhook', success: true });
            log.info({ approvalId: payload.approvalId, url: process.env.WEBHOOK_URL }, 'Notification: Webhook dispatched');
        } catch (err: any) {
            results.push({ channel: 'webhook', success: false, error: err.message });
            log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: Webhook failed');
        }
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
                headers: {
                    'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
                    'Content-Type': 'application/json',
                },
                timeout: 10000,
            });
            results.push({ channel: 'sendgrid', success: true });
            log.info({ approvalId: payload.approvalId }, 'Notification: Email sent via SendGrid');
        } catch (err: any) {
            results.push({ channel: 'sendgrid', success: false, error: err.message });
            log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: SendGrid failed');
        }
    }

    // 3. Slack Webhook
    if (process.env.SLACK_WEBHOOK_URL) {
        try {
            await axios.post(process.env.SLACK_WEBHOOK_URL, {
                text: `🛡️ *GovAI — ${payload.event}*`,
                blocks: [
                    {
                        type: 'header',
                        text: { type: 'plain_text', text: `🛡️ ${payload.event}` }
                    },
                    {
                        type: 'section',
                        fields: [
                            { type: 'mrkdwn', text: `*Motivo:*\n${payload.reason}` },
                            { type: 'mrkdwn', text: `*Approval ID:*\n\`${payload.approvalId}\`` },
                            { type: 'mrkdwn', text: `*Organização:*\n${payload.orgId}` },
                            { type: 'mrkdwn', text: `*Expira:*\n${payload.expiresAt || 'N/A'}` },
                        ]
                    }
                ]
            }, { timeout: 5000 });
            results.push({ channel: 'slack', success: true });
            log.info({ approvalId: payload.approvalId }, 'Notification: Slack message sent');
        } catch (err: any) {
            results.push({ channel: 'slack', success: false, error: err.message });
            log.warn({ approvalId: payload.approvalId, error: err.message }, 'Notification: Slack failed');
        }
    }

    // 4. Fallback: structured log if no channel configured
    if (results.length === 0) {
        log.warn(payload, 'Notification: No channels configured — logging payload');
        results.push({ channel: 'log', success: true });
    }

    return results;
}
