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
};

export default api;
