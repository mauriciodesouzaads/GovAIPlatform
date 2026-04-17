import axios from 'axios';
import { getAuthToken } from '@/lib/auth-storage';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const api = axios.create({
    baseURL: API_BASE,
});

api.interceptors.request.use((config) => {
    if (typeof window !== 'undefined') {
        const token = getAuthToken();
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});

export const ENDPOINTS = {
    LOGIN: '/v1/admin/login',
    LOGOUT: '/v1/admin/logout',
    ME: '/v1/admin/me',
    STATS: '/v1/admin/stats',
    AUDIT_LOGS: '/v1/admin/audit-logs',
    ORGANIZATIONS: '/v1/admin/organizations',
    ORGANIZATIONS_TELEMETRY_CONSENTED: '/v1/admin/organizations/telemetry-consented',
    ORGANIZATION_TELEMETRY_CONSENT: (id: string) => `/v1/admin/organizations/${id}/telemetry-consent`,
    COMPLIANCE_DPO_SUMMARY: '/v1/admin/compliance/dpo-summary',
    COMPLIANCE_AUDIT_TRAIL: (from?: string, to?: string) => {
        const params = new URLSearchParams({ format: 'csv' });
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        return `/v1/admin/compliance/audit-trail?${params.toString()}`;
    },
    USERS: '/v1/admin/users',
    ASSISTANTS: '/v1/admin/assistants',
    APPROVALS: '/v1/admin/approvals',
    POLICIES: '/v1/admin/policy_versions',
    MCP: '/v1/admin/mcp_servers',
    KNOWLEDGE: '/v1/admin/knowledge',
    API_KEYS: '/v1/admin/api-keys',
    REPORTS_COMPLIANCE: '/v1/admin/reports/compliance',
    REPORTS_COMPLIANCE_AUDIT: '/v1/admin/reports/compliance-audit',

    // Governance Policies (visual editor)
    GOV_POLICIES: '/v1/admin/policies',
    GOV_POLICY: (id: string) => `/v1/admin/policies/${id}`,
    GOV_POLICY_HISTORY: (id: string) => `/v1/admin/policies/${id}/history`,
    GOV_POLICY_DIFF: (id: string, otherId: string) => `/v1/admin/policies/${id}/diff/${otherId}`,

    // Policy Exceptions
    POLICY_EXCEPTIONS: '/v1/admin/policy-exceptions',
    POLICY_EXCEPTIONS_EXPIRING: '/v1/admin/policy-exceptions/expiring',
    POLICY_EXCEPTION_APPROVE: (id: string) => `/v1/admin/policy-exceptions/${id}/approve`,
    POLICY_EXCEPTION_REJECT: (id: string) => `/v1/admin/policy-exceptions/${id}/reject`,
    POLICY_EXCEPTION_REVOKE: (id: string) => `/v1/admin/policy-exceptions/${id}`,

    // Shield Detection
    SHIELD_POSTURE:           '/v1/admin/shield/posture',
    SHIELD_POSTURE_GENERATE:  '/v1/admin/shield/posture/generate',
    SHIELD_POSTURE_HISTORY:   '/v1/admin/shield/posture/history',
    SHIELD_FINDINGS:          '/v1/admin/shield/findings',
    SHIELD_FINDING_ACTIONS:   (id: string) => `/v1/admin/shield/findings/${id}/actions`,
    SHIELD_ACKNOWLEDGE:       (id: string) => `/v1/admin/shield/findings/${id}/acknowledge`,
    SHIELD_PROMOTE:           (id: string) => `/v1/admin/shield/findings/${id}/promote`,
    SHIELD_ACCEPT_RISK:       (id: string) => `/v1/admin/shield/findings/${id}/accept-risk`,
    SHIELD_DISMISS:           (id: string) => `/v1/admin/shield/findings/${id}/dismiss`,
    SHIELD_SYNC_CATALOG:      '/v1/admin/shield/sync-catalog',
    SHIELD_DEDUPE:            '/v1/admin/shield/dedupe',
    SHIELD_METRICS:           '/v1/admin/shield/metrics',
    SHIELD_EXPORT_JSON:       '/v1/admin/shield/export/findings',
    SHIELD_EXPORT_CSV:        '/v1/admin/shield/export/findings.csv',
    SHIELD_COLLECTOR_HEALTH:  '/v1/admin/shield/collectors/health',
    SHIELD_REPORT_EXECUTIVE:  '/v1/admin/shield/reports/executive',

    // Catalog Registry
    CATALOG_ASSISTANTS:       '/v1/admin/assistants',
    CATALOG_LIST:             '/v1/admin/catalog',
    CATALOG_METADATA:         (id: string) => `/v1/admin/assistants/${id}/metadata`,
    CATALOG_SUBMIT_REVIEW:    (id: string) => `/v1/admin/assistants/${id}/submit-for-review`,
    CATALOG_REVIEW:           (id: string) => `/v1/admin/assistants/${id}/catalog-review`,
    CATALOG_SUSPEND:          (id: string) => `/v1/admin/assistants/${id}/suspend`,
    CATALOG_ARCHIVE:          (id: string) => `/v1/admin/assistants/${id}/archive`,
    CATALOG_EXIT_PERIMETER:   (id: string) => `/v1/admin/assistants/${id}/exit-perimeter`,
    ASSISTANT_EVIDENCE:       (id: string) => `/v1/admin/assistants/${id}/evidence`,
    ASSISTANT_EVIDENCE_PDF:   (id: string) => `/v1/admin/assistants/${id}/evidence/pdf`,
    ASSISTANT_VERSIONS:       (id: string) => `/v1/admin/assistants/${id}/versions`,
    ASSISTANT_VERSION_DIFF:   (id: string, v1Id: string, v2Id: string) => `/v1/admin/assistants/${id}/versions/${v1Id}/diff/${v2Id}`,
    REVIEW_TRACKS:            '/v1/admin/review-tracks',
    REVIEW_STATUS:            (id: string) => `/v1/admin/assistants/${id}/review-status`,
    REVIEW_TRACK_DECIDE:      (id: string, trackId: string) => `/v1/admin/assistants/${id}/review/${trackId}`,
    ASSISTANT_FAVORITE:       (id: string) => `/v1/admin/assistants/${id}/favorite`,
    ASSISTANT_FAVORITES:      '/v1/admin/assistants/favorites',

    // Webhooks
    WEBHOOKS:                 '/v1/admin/webhooks',
    WEBHOOK:                  (id: string) => `/v1/admin/webhooks/${id}`,
    WEBHOOK_DELIVERIES:       (id: string) => `/v1/admin/webhooks/${id}/deliveries`,
    WEBHOOK_DELIVERY_RETRY:   (webhookId: string, deliveryId: string) => `/v1/admin/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,

    // Audit Export
    AUDIT_EXPORT:             '/v1/admin/audit-logs/export',

    // Settings
    SETTINGS_ORGANIZATION:    '/v1/admin/settings/organization',
    SETTINGS_REVIEW_TRACKS:   '/v1/admin/settings/review-tracks',
    SETTINGS_REVIEW_TRACK:    (id: string) => `/v1/admin/settings/review-tracks/${id}`,
    SETTINGS_TRACKS_REORDER:  '/v1/admin/settings/review-tracks/reorder',
    SETTINGS_RETENTION:       '/v1/admin/settings/retention',
    SETTINGS_RETENTION_PREVIEW: (days: number) => `/v1/admin/settings/retention/preview?days=${days}`,

    // Platform Admin — Organization Management
    PLATFORM_ORGS:            '/v1/admin/organizations',
    PLATFORM_ORG:             (id: string) => `/v1/admin/organizations/${id}`,
    PLATFORM_ORG_INVITE:      (id: string) => `/v1/admin/organizations/${id}/invite-admin`,

    // Models
    MODELS_LIST:              '/v1/admin/models',

    // Public (no admin auth — API key only)
    PUBLIC_ASSISTANT_INFO:    (id: string) => `/v1/public/assistant/${id}`,

    // Architect Domain
    ARCHITECT_CASES:                  '/v1/admin/architect/cases',
    ARCHITECT_CASE:                   (id: string) => `/v1/admin/architect/cases/${id}`,
    ARCHITECT_CASE_STATUS:            (id: string) => `/v1/admin/architect/cases/${id}/status`,
    ARCHITECT_CASE_CONTRACT:          (id: string) => `/v1/admin/architect/cases/${id}/contract`,
    ARCHITECT_CASE_CONTRACT_ACCEPT:   (id: string) => `/v1/admin/architect/cases/${id}/contract/accept`,
    ARCHITECT_CASE_DISCOVER:          (id: string) => `/v1/admin/architect/cases/${id}/discover`,
    ARCHITECT_CASE_DISCOVER_ANSWER:   (id: string) => `/v1/admin/architect/cases/${id}/discover/answer`,
    ARCHITECT_CASE_DISCOVER_QUESTIONS:(id: string) => `/v1/admin/architect/cases/${id}/discover/questions`,
    ARCHITECT_CASE_DISCOVER_STATUS:   (id: string) => `/v1/admin/architect/cases/${id}/discover/status`,
    ARCHITECT_CASE_DECISIONS:         (id: string) => `/v1/admin/architect/cases/${id}/decisions`,
    ARCHITECT_CASE_WORK_ITEMS:        (id: string) => `/v1/admin/architect/cases/${id}/work-items`,
    ARCHITECT_DECISION_PROPOSE:       (id: string) => `/v1/admin/architect/decisions/${id}/propose`,
    ARCHITECT_DECISION_APPROVE:       (id: string) => `/v1/admin/architect/decisions/${id}/approve`,
    ARCHITECT_DECISION_REJECT:        (id: string) => `/v1/admin/architect/decisions/${id}/reject`,
    ARCHITECT_DECISION_COMPILE:       (id: string) => `/v1/admin/architect/decisions/${id}/compile`,
    ARCHITECT_DECISION_DOCUMENT:      (id: string) => `/v1/admin/architect/decisions/${id}/document`,
    ARCHITECT_WORK_ITEM:              (id: string) => `/v1/admin/architect/work-items/${id}`,
    ARCHITECT_WORK_ITEM_DISPATCH:     (id: string) => `/v1/admin/architect/work-items/${id}/dispatch`,
    ARCHITECT_WORK_ITEM_CANCEL:       (id: string) => `/v1/admin/architect/work-items/${id}/cancel`,
    ARCHITECT_WORK_ITEM_EVENTS:       (id: string) => `/v1/admin/architect/work-items/${id}/events`,
    ARCHITECT_WORK_ITEM_APPROVE_ACTION: (id: string) => `/v1/admin/architect/work-items/${id}/approve-action`,
    ARCHITECT_WORKFLOW_DISPATCH_ALL:  (id: string) => `/v1/admin/architect/cases/${id}/workflow/dispatch-all`,
    ARCHITECT_CASE_SUMMARY:           (id: string) => `/v1/admin/architect/cases/${id}/summary`,

    // Compliance Hub
    COMPLIANCE_HUB_FRAMEWORKS:        '/v1/admin/compliance-hub/frameworks',
    COMPLIANCE_HUB_CONTROLS:          (frameworkId: string) => `/v1/admin/compliance-hub/frameworks/${frameworkId}/controls`,
    COMPLIANCE_HUB_ASSESSMENT:        (controlId: string) => `/v1/admin/compliance-hub/assessments/${controlId}`,
    COMPLIANCE_HUB_AUTO_ASSESS:       (frameworkId: string) => `/v1/admin/compliance-hub/auto-assess/${frameworkId}`,
    COMPLIANCE_HUB_SUMMARY:           '/v1/admin/compliance-hub/summary',

    // Model Cards
    MODEL_CARD:                       (assistantId: string) => `/v1/admin/assistants/${assistantId}/model-card`,

    // Risk Assessments
    RISK_ASSESSMENTS:                 (assistantId: string) => `/v1/admin/risk-assessments/${assistantId}`,
    RISK_ASSESSMENT_CREATE:           (assistantId: string) => `/v1/admin/risk-assessments/${assistantId}`,
    RISK_ASSESSMENT_ANSWERS:          (assessmentId: string) => `/v1/admin/risk-assessments/${assessmentId}/answers`,
    RISK_ASSESSMENT_COMPLETE:         (assessmentId: string) => `/v1/admin/risk-assessments/${assessmentId}/complete`,
    RISK_ASSESSMENT_EXPORT:           (assessmentId: string) => `/v1/admin/risk-assessments/${assessmentId}/export`,

    // Monitoring
    MONITORING_REALTIME:              '/v1/admin/monitoring/realtime',
    MONITORING_TRENDS:                (days?: number) => `/v1/admin/monitoring/trends${days ? `?days=${days}` : ''}`,
    MONITORING_ALERTS:                '/v1/admin/monitoring/alerts',
    MONITORING_THRESHOLDS:            '/v1/admin/monitoring/thresholds',

    // DLP Rules (FASE 4b)
    DLP_RULES:                        '/v1/admin/dlp/rules',
    DLP_RULE:                         (id: string) => `/v1/admin/dlp/rules/${id}`,
    DLP_TEST:                         '/v1/admin/dlp/test',

    // Notification Channels (FASE 4c)
    NOTIFICATION_CHANNELS:            '/v1/admin/notification-channels',
    NOTIFICATION_CHANNEL:             (id: string) => `/v1/admin/notification-channels/${id}`,
    NOTIFICATION_CHANNELS_TEST:       '/v1/admin/notification-channels/test',
    NOTIFICATION_CHANNELS_PREVIEW:    '/v1/admin/notification-channels/preview',
    NOTIFICATION_CHANNELS_EVENTS:     '/v1/admin/notification-channels/events',

    // Catalog Skills (FASE 5c)
    CATALOG_SKILLS:                   '/v1/admin/catalog/skills',
    CATALOG_SKILL:                    (id: string) => `/v1/admin/catalog/skills/${id}`,
    CATALOG_SKILLS_FOR_ASSISTANT:     (assistantId: string) => `/v1/admin/catalog/skills/assistants/${assistantId}`,
    CATALOG_SKILL_BIND:               (assistantId: string) => `/v1/admin/catalog/skills/assistants/${assistantId}/bindings`,
    CATALOG_SKILL_UNBIND:             (assistantId: string, skillId: string) => `/v1/admin/catalog/skills/assistants/${assistantId}/bindings/${skillId}`,

    // Architect Workflow Templates (FASE 5c)
    ARCHITECT_TEMPLATES:              '/v1/admin/architect/templates',
    ARCHITECT_TEMPLATE:               (id: string) => `/v1/admin/architect/templates/${id}`,
    ARCHITECT_TEMPLATE_INSTANTIATE:   (id: string) => `/v1/admin/architect/templates/${id}/instantiate`,

    // Assistant Delegation Config (FASE 5d)
    ASSISTANT_DELEGATION:             (id: string) => `/v1/admin/assistants/${id}/delegation`,

    // Chat wrapper (FASE 6)
    CHAT_SEND:                        '/v1/admin/chat/send',
    CHAT_SEND_STREAM:                 '/v1/admin/chat/send/stream',
    CHAT_SESSIONS:                    '/v1/admin/chat/sessions',
    CHAT_SESSION_MESSAGES:            (id: string) => `/v1/admin/chat/sessions/${id}/messages`,
    ASSISTANTS_AVAILABLE:             '/v1/admin/assistants/available',
    LLM_MODELS:                       '/v1/admin/llm/models',
    // FASE 7 — Dual governed runtime
    RUNTIMES:                         '/v1/admin/runtimes',
    RUNTIME_SWITCH:                   '/v1/admin/runtime-switch',

    // FASE 13.1 — Bias Detection
    BIAS_SUBMIT:                      '/v1/admin/bias-assessments',
    BIAS_BY_VERSION:                  (versionId: string) => `/v1/admin/bias-assessments/version/${versionId}`,
    BIAS_ONE:                         (id: string) => `/v1/admin/bias-assessments/${id}`,
    BIAS_EVIDENCE:                    (id: string) => `/v1/admin/bias-assessments/${id}/evidence`,

    // FASE 13.2 — ICP-Brasil signing
    ICP_CERTIFICATES:                 '/v1/admin/icp-certificates',
    ICP_CERTIFICATE_DELETE:           (id: string) => `/v1/admin/icp-certificates/${id}`,
    ICP_CERTIFICATE_VERIFY:           (id: string) => `/v1/admin/icp-certificates/${id}/verify`,
};

export default api;
