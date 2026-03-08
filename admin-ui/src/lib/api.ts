import axios from 'axios';

// Centralized API configuration
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// Configure Axios instance
const api = axios.create({
    baseURL: API_BASE,
});

// Request interceptor for JWT injection
api.interceptors.request.use((config) => {
    if (typeof window !== 'undefined') {
        const token = localStorage.getItem('govai_admin_token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});

export const ENDPOINTS = {
    LOGIN: `/v1/admin/login`,
    STATS: `/v1/admin/stats`,
    AUDIT_LOGS: `/v1/admin/audit-logs`,
    ORGANIZATIONS: `/v1/admin/organizations`,
    USERS: `/v1/admin/users`,
    ASSISTANTS: `/v1/admin/assistants`,
    APPROVALS: `/v1/admin/approvals`,
    POLICIES: `/v1/admin/policy_versions`,
    MCP: `/v1/admin/mcp_servers`,
    KNOWLEDGE: `/v1/admin/knowledge`,
};

export default api;
