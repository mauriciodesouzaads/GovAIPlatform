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
};

export default api;
