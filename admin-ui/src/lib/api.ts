// Centralized API configuration
// In production, set NEXT_PUBLIC_API_URL in your .env.local or Docker env
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const ENDPOINTS = {
    LOGIN: `${API_BASE}/v1/admin/login`,
    STATS: `${API_BASE}/v1/admin/stats`,
    LOGS: `${API_BASE}/v1/admin/logs`,
    ORGANIZATIONS: `${API_BASE}/v1/admin/organizations`,
    USERS: `${API_BASE}/v1/admin/users`,
    ASSISTANTS: `${API_BASE}/v1/admin/assistants`,
};
