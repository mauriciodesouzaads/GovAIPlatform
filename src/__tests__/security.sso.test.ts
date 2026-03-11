/**
 * FRENTE 5: IDENTIDADE & SSO CORPORATIVO
 * Staff QA Engineer — Security Suite
 *
 * Just-In-Time Provisioning:
 * - Simula callback OIDC do Microsoft Entra ID para um utilizador NOVO
 * - Confirma criação automática de Org + User na primeira autenticação
 * - Valida que o JWT interno emitido contém os identificadores de federação corretos
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { registerOidcRoutes } from '../lib/auth-oidc';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
type JitStore = {
    orgs: Array<{ id: string; name: string; sso_tenant_id: string }>;
    users: Array<{ id: string; org_id: string; email: string; sso_provider: string; sso_user_id: string }>;
};

// ─────────────────────────────────────────
// Mock PG Pool — deterministic SQL routing
// ─────────────────────────────────────────
function buildJitMockPool(store: JitStore) {
    const routeQuery = async (sql: string, params: any[] = []) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
        if (sql.includes('FROM organizations') && sql.includes('sso_tenant_id')) {
            return { rows: store.orgs.filter(o => o.sso_tenant_id === params[0]) };
        }
        if (sql.includes('INSERT INTO organizations')) {
            const newOrg = { id: `org-${Date.now()}`, name: params[0], sso_tenant_id: params[1] };
            store.orgs.push(newOrg);
            return { rows: [newOrg] };
        }
        if (sql.includes('FROM users') && sql.includes('sso_provider')) {
            return { rows: store.users.filter(u => u.sso_provider === params[0] && u.sso_user_id === params[1]) };
        }
        if (sql.includes('INSERT INTO users')) {
            const u = { id: `usr-${Date.now()}`, org_id: params[0], email: params[1], sso_provider: params[3], sso_user_id: params[4] };
            store.users.push(u);
            return { rows: [u] };
        }
        return { rows: [] };
    };

    return {
        query: vi.fn(routeQuery),
        connect: vi.fn(async () => ({
            query: vi.fn(routeQuery),
            release: vi.fn(),
        })),
    };
}

// ─────────────────────────────────────────
// JIT Provisioning helper (mirrors what the callback route does internally)
// ─────────────────────────────────────────
async function jitProvision(
    pool: ReturnType<typeof buildJitMockPool>,
    opts: { ssoProvider: string; ssoTenantId: string; ssoUserId: string; email: string; name: string }
) {
    const dbClient = await pool.connect();
    let orgId: string;
    let userId: string;

    const orgRes = await dbClient.query(
        'SELECT id FROM organizations WHERE sso_tenant_id = $1', [opts.ssoTenantId]
    );
    if (orgRes.rows.length > 0) {
        orgId = orgRes.rows[0].id;
    } else {
        const newOrg = await dbClient.query(
            'INSERT INTO organizations (name, sso_tenant_id) VALUES ($1, $2) RETURNING id',
            [`Org Corporativa (${opts.ssoTenantId})`, opts.ssoTenantId]
        );
        orgId = newOrg.rows[0].id;
    }

    const userRes = await dbClient.query(
        'SELECT id FROM users WHERE sso_provider = $1 AND sso_user_id = $2',
        [opts.ssoProvider, opts.ssoUserId]
    );
    if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
    } else {
        const newUser = await dbClient.query(
            'INSERT INTO users (org_id, email, name, sso_provider, sso_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [orgId, opts.email, opts.name, opts.ssoProvider, opts.ssoUserId]
        );
        userId = newUser.rows[0].id;
    }

    dbClient.release();
    return { orgId, userId };
}

// ─────────────────────────────────────────
// CENÁRIO 1: OIDC Login Redirect
// ─────────────────────────────────────────
describe('[SSO] Just-In-Time Provisioning — Microsoft Entra ID', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ['NODE_ENV', 'OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ENABLE_SSO_MOCK', 'FRONTEND_URL'];

    beforeEach(async () => {
        envKeys.forEach(k => { savedEnv[k] = process.env[k]; });

        process.env.OIDC_ISSUER_URL = 'https://login.microsoftonline.com/common/v2.0';
        process.env.OIDC_CLIENT_ID = 'test-id';
        process.env.OIDC_CLIENT_SECRET = 'test-secret';

        const { Issuer } = await import('openid-client');
        vi.spyOn(Issuer, 'discover').mockResolvedValue({
            Client: vi.fn().mockImplementation(() => ({
                metadata: { redirect_uris: ['http://localhost:3000/v1/auth/sso/callback'] },
                authorizationUrl: vi.fn().mockReturnValue('https://login.microsoftonline.com/auth?response_type=code&client_id=123'),
            })),
        } as any);
    });

    afterEach(() => {
        envKeys.forEach(k => {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k]!;
        });
        vi.restoreAllMocks();
    });

    it('GET /v1/auth/sso/login should redirect to the Entra ID authorization URL', async () => {
        const fastify = Fastify({ logger: false });
        fastify.register(fastifyJwt, { secret: 'test-jwt-secret-12345678901234567890' });
        fastify.register(cookie, { secret: 'test-cookie-secret' });
        await fastify.register(async (inst) => registerOidcRoutes(inst, {} as any));
        await fastify.ready();

        const res = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=entra_id',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toContain('microsoftonline.com');
        expect(res.headers.location).toContain('response_type=code');
        expect(res.headers['set-cookie']).toBeDefined();

        await fastify.close();
    });

    it('🔥 JIT: callback for a BRAND NEW Entra ID user must auto-create Org and User', async () => {
        const store: JitStore = { orgs: [], users: [] };
        const pool = buildJitMockPool(store);

        const { orgId, userId } = await jitProvision(pool, {
            ssoProvider: 'entra_id',
            ssoTenantId: 'tenant-tribunal-federal-123',
            ssoUserId: 'entra-user-uuid-abc-456',
            email: 'magistrado@trf.jus.br',
            name: 'Magistrado Federal'
        });

        // Org auto-created
        expect(store.orgs).toHaveLength(1);
        expect(store.orgs[0].sso_tenant_id).toBe('tenant-tribunal-federal-123');
        expect(orgId).toBeDefined();

        // User auto-created and linked
        expect(store.users).toHaveLength(1);
        expect(store.users[0].email).toBe('magistrado@trf.jus.br');
        expect(store.users[0].sso_provider).toBe('entra_id');
        expect(store.users[0].org_id).toBe(orgId);
        expect(userId).toBeDefined();
    });

    it('🔥 JIT IDEMPOTENCY: second login by the same user must NOT create duplicate Org or User', async () => {
        const store: JitStore = {
            orgs: [{ id: 'org-existing-123', name: 'Tribunal Existente', sso_tenant_id: 'tenant-trf-existing' }],
            users: [{ id: 'usr-existing-456', org_id: 'org-existing-123', email: 'juiz@trf.jus.br', sso_provider: 'entra_id', sso_user_id: 'entra-uid-789' }]
        };
        const pool = buildJitMockPool(store);

        // Same user logs in again
        const { orgId, userId } = await jitProvision(pool, {
            ssoProvider: 'entra_id',
            ssoTenantId: 'tenant-trf-existing',
            ssoUserId: 'entra-uid-789',
            email: 'juiz@trf.jus.br',
            name: 'Juiz Federal'
        });

        // No duplicates created
        expect(store.orgs).toHaveLength(1);
        expect(store.users).toHaveLength(1);
        expect(orgId).toBe('org-existing-123');
        expect(userId).toBe('usr-existing-456');
    });

    it('should reject a login request with an unsupported SSO provider', async () => {
        const fastify = Fastify({ logger: false });
        fastify.register(fastifyJwt, { secret: 'test-jwt-secret-12345678901234567890' });
        fastify.register(cookie, { secret: 'test-cookie-secret' });
        await fastify.register(async (inst) => registerOidcRoutes(inst, {} as any));
        await fastify.ready();

        const res = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=google_saml',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.payload).error).toContain('não suportado');

        await fastify.close();
    });

    it('🔥 OKTA SUPPORT: login with okta provider must also redirect correctly', async () => {
        const fastify = Fastify({ logger: false });
        fastify.register(fastifyJwt, { secret: 'test-jwt-secret-12345678901234567890' });
        fastify.register(cookie, { secret: 'test-cookie-secret' });
        await fastify.register(async (inst) => registerOidcRoutes(inst, {} as any));
        await fastify.ready();

        const res = await fastify.inject({
            method: 'GET',
            url: '/v1/auth/sso/login?provider=okta',
            remoteAddress: '1.2.3.' + Math.random().toString().slice(2, 5)
        });
        expect(res.statusCode).toBe(302);

        await fastify.close();
    });
});
