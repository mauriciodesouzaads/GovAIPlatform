import axios from 'axios';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const api = axios.create({
    baseURL: API_BASE,
    // withCredentials garante que o httpOnly cookie 'token' seja enviado em toda
    // requisição cross-origin — necessário para sessões SSO (Etapa 2/3).
    withCredentials: true,
});

// Interceptor de autenticação: injeta Bearer token do localStorage quando disponível.
// Se não houver token (fluxo SSO), o httpOnly cookie é enviado automaticamente
// pelo browser via withCredentials e o servidor extrai o JWT diretamente.
api.interceptors.request.use(async (config) => {
    if (typeof window !== 'undefined') {
        const token = localStorage.getItem('govai_admin_token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        // Sem token no localStorage → não define Authorization header.
        // O server.ts está configurado para extrair o JWT do httpOnly cookie 'token'.
    } else {
        // SSR: lê o cookie httpOnly server-side via next/headers (Node.js pode ler httpOnly cookies)
        try {
            const { cookies } = await import('next/headers');
            const cookieStore = await cookies();
            const tokenCookie = cookieStore.get('token');
            if (tokenCookie?.value) {
                config.headers.Authorization = `Bearer ${tokenCookie.value}`;
            }
        } catch {
            // Contexto fora de request SSR — ignorar silenciosamente
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
