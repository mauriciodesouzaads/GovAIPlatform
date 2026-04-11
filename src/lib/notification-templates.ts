/**
 * Notification Templates — Slack Blocks API + Microsoft Teams Adaptive Cards
 *
 * Generates platform-specific payloads for Slack and Teams webhooks.
 * All text is in PT-BR. Severity drives colour and emoji.
 */

// ── Event catalogue ──────────────────────────────────────────────────────────

export const NOTIFICATION_EVENTS = [
    { value: 'policy.violation',          label: 'Violação de Política',         severity: 'critical', category: 'compliance' },
    { value: 'execution.error',           label: 'Erro de Execução',             severity: 'warning',  category: 'technical'  },
    { value: 'exception.expiring',        label: 'Exceção Expirando',            severity: 'warning',  category: 'compliance' },
    { value: 'exception.created',         label: 'Nova Exceção Criada',          severity: 'info',     category: 'compliance' },
    { value: 'assistant.published',       label: 'Assistente Publicado',         severity: 'info',     category: 'lifecycle'  },
    { value: 'review.completed',          label: 'Revisão Concluída',            severity: 'info',     category: 'lifecycle'  },
    { value: 'alert.high_latency',        label: 'Latência Alta',                severity: 'warning',  category: 'technical'  },
    { value: 'alert.high_violation',      label: 'Taxa de Violação Alta',        severity: 'critical', category: 'compliance' },
    { value: 'alert.high_cost',           label: 'Custo Diário Alto',            severity: 'warning',  category: 'technical'  },
    { value: 'dlp.block',                 label: 'Bloqueio pelo DLP',            severity: 'critical', category: 'compliance' },
    { value: 'risk.assessment_completed', label: 'Avaliação de Risco Concluída', severity: 'info',     category: 'compliance' },
] as const;

export type NotificationEvent = typeof NOTIFICATION_EVENTS[number]['value'];

// ── Severity helpers ─────────────────────────────────────────────────────────

const SLACK_COLORS: Record<string, string> = {
    critical: '#e74c3c',
    warning:  '#f39c12',
    info:     '#3498db',
};

function severityLabel(s: string): string {
    return s === 'critical' ? '🔴 Crítico' : s === 'warning' ? '🟡 Atenção' : '🔵 Informativo';
}

function severityEmoji(s: string): string {
    return s === 'critical' ? '🔴' : s === 'warning' ? '🟡' : '🔵';
}

// ── Event payload ────────────────────────────────────────────────────────────

export interface EventPayload {
    event:          NotificationEvent;
    org_name?:      string;
    assistant_name?: string;
    assistant_id?:  string;
    user_email?:    string;
    details?:       string;
    timestamp?:     string;
    trace_id?:      string;
    metadata?:      Record<string, unknown>;
    base_url?:      string;
}

// ── Deep-link URL helper ─────────────────────────────────────────────────────

function actionUrl(payload: EventPayload): string {
    const base = payload.base_url || 'http://localhost:3001';
    const id   = payload.assistant_id;
    if (!id) return base;
    if (payload.event === 'policy.violation' || payload.event === 'dlp.block') return `${base}/evidence/${id}`;
    if (payload.event === 'risk.assessment_completed')                          return `${base}/risk-assessment/${id}`;
    if (payload.event.startsWith('alert.'))                                     return base;
    return `${base}/catalog`;
}

// ── Slack Blocks API ─────────────────────────────────────────────────────────

export function buildSlackPayload(payload: EventPayload): object {
    const eventDef  = NOTIFICATION_EVENTS.find(e => e.value === payload.event);
    const severity  = eventDef?.severity || 'info';
    const color     = SLACK_COLORS[severity] || SLACK_COLORS.info;
    const title     = eventDef?.label || payload.event;
    const timestamp = payload.timestamp || new Date().toISOString();
    const url       = actionUrl(payload);

    const fields: Array<{ type: string; text: string }> = [];
    if (payload.assistant_name) fields.push({ type: 'mrkdwn', text: `*Assistente:*\n${payload.assistant_name}` });
    if (payload.user_email)     fields.push({ type: 'mrkdwn', text: `*Usuário:*\n${payload.user_email}` });
    if (payload.details)        fields.push({ type: 'mrkdwn', text: `*Detalhes:*\n${payload.details}` });
    if (payload.trace_id)       fields.push({ type: 'mrkdwn', text: `*Trace ID:*\n\`${payload.trace_id}\`` });

    const blocks: unknown[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `🔔 ${title}`, emoji: true },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `*Severidade:* ${severityLabel(severity)}\n*Horário:* ${new Date(timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
            },
        },
    ];

    if (fields.length > 0) blocks.push({ type: 'section', fields });

    blocks.push({
        type: 'actions',
        elements: [{
            type:  'button',
            text:  { type: 'plain_text', text: '📊 Ver no GovAI', emoji: true },
            url,
            style: severity === 'critical' ? 'danger' : 'primary',
        }],
    });

    blocks.push({ type: 'divider' });
    blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `GovAI GRC Platform • ${payload.org_name || 'Organização'}` }],
    });

    return { attachments: [{ color, blocks }] };
}

// ── Teams Adaptive Cards ─────────────────────────────────────────────────────

export function buildTeamsPayload(payload: EventPayload): object {
    const eventDef    = NOTIFICATION_EVENTS.find(e => e.value === payload.event);
    const severity    = eventDef?.severity || 'info';
    const title       = eventDef?.label || payload.event;
    const timestamp   = payload.timestamp || new Date().toISOString();
    const url         = actionUrl(payload);
    const accentColor = severity === 'critical' ? 'attention' : severity === 'warning' ? 'warning' : 'accent';

    const facts: Array<{ title: string; value: string }> = [
        { title: 'Severidade', value: `${severityEmoji(severity)} ${severity === 'critical' ? 'Crítico' : severity === 'warning' ? 'Atenção' : 'Informativo'}` },
        { title: 'Horário',    value: new Date(timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) },
    ];
    if (payload.assistant_name) facts.push({ title: 'Assistente', value: payload.assistant_name });
    if (payload.user_email)     facts.push({ title: 'Usuário',    value: payload.user_email });
    if (payload.details)        facts.push({ title: 'Detalhes',   value: payload.details });
    if (payload.trace_id)       facts.push({ title: 'Trace ID',   value: payload.trace_id });

    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                type:    'AdaptiveCard',
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                version: '1.4',
                body: [
                    {
                        type:   'TextBlock',
                        text:   `🔔 ${title}`,
                        weight: 'bolder',
                        size:   'large',
                        color:  accentColor,
                    },
                    { type: 'FactSet', facts },
                ],
                actions: [{
                    type:  'Action.OpenUrl',
                    title: '📊 Ver no GovAI',
                    url,
                }],
            },
        }],
    };
}

// ── Preview helper (frontend use) ────────────────────────────────────────────

const MOCK_PAYLOAD: Omit<EventPayload, 'event'> = {
    org_name:       'Minha Organização',
    assistant_name: 'Assistente Jurídico',
    assistant_id:   '00000000-0000-0000-0002-000000000001',
    user_email:     'usuario@org.com',
    details:        'Execução bloqueada: conteúdo detectado como violação da política de dados sensíveis.',
    timestamp:      new Date().toISOString(),
    trace_id:       'abc123-def456',
    base_url:       'http://localhost:3001',
};

export function buildPreviewPayload(provider: string, event: NotificationEvent): object {
    const full: EventPayload = { ...MOCK_PAYLOAD, event };
    if (provider === 'slack') return buildSlackPayload(full);
    if (provider === 'teams') return buildTeamsPayload(full);
    return {};
}
