/**
 * P-01: RLS Login Bypass Elimination — Security Tests
 *
 * Verifica que o endpoint POST /v1/admin/login:
 *   1. Consulta user_lookup (sem RLS) ANTES de setar app.current_org_id
 *   2. Seta o contexto de org correto com SET CONFIG
 *   3. Consulta users COM RLS ativo (org isolado)
 *   4. Retorna JWT com org_id correto para o tenant do usuário
 *   5. Não vaza dados de outro tenant mesmo com email válido de outra org
 *   6. Retorna 401 quando email não existe em user_lookup
 *   7. Retorna 401 quando senha é inválida
 *   8. requireApiKey usa api_key_lookup (sem RLS) — não depende de IS NULL
 *
 * Pattern: Fastify in-process + mock pg.Pool. Sem DB real.
 * Bcrypt cost factor 1 (seguro para testes — velocidade > resistência a ataque).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import bcrypt from 'bcrypt';
import { adminRoutes } from '../routes/admin.routes';

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET  = 'test-jwt-secret-login-isolation-min32!!';
const SIGN_SECRET = 'test-signing-secret-login-isolation-min32!!';

const ORG_A_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_A_ID  = 'user-aaaa-0000-0000-0000-000000000001';
const USER_B_ID  = 'user-bbbb-0000-0000-0000-000000000002';
const EMAIL_A    = 'alice@orga.com';
const EMAIL_B    = 'bob@orgb.com';
const VALID_PASS = 'SecurePass@2026!';

let passwordHash: string;

// ── SQL capture ───────────────────────────────────────────────────────────────

const capturedSql: Array<{ sql: string; params: any[] }> = [];

// ── Mock pool factory ─────────────────────────────────────────────────────────

function buildMockPool(overrides: {
    lookupRows?: Record<string, { user_id: string; org_id: string }>;
    usersRows?: Record<string, object>;
} = {}) {
    const lookupRows = overrides.lookupRows ?? {
        [EMAIL_A]: { user_id: USER_A_ID, org_id: ORG_A_ID },
        [EMAIL_B]: { user_id: USER_B_ID, org_id: ORG_B_ID },
    };

    const usersRows = overrides.usersRows ?? {
        [EMAIL_A]: {
            id: USER_A_ID,
            org_id: ORG_A_ID,
            password_hash: passwordHash,
            role: 'admin',
            requires_password_change: false,
        },
        [EMAIL_B]: {
            id: USER_B_ID,
            org_id: ORG_B_ID,
            password_hash: passwordHash,
            role: 'operator',
            requires_password_change: false,
        },
    };

    const handleQuery = async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        capturedSql.push({ sql: s.toLowerCase(), params });

        // set_config / transaction control
        if (/set_config|^begin$|^commit$|^rollback$/i.test(s)) {
            return { rows: [] };
        }

        // user_lookup: lookup by email (P-01 — no RLS required)
        if (/from user_lookup where email/i.test(s)) {
            const email = params[0] as string;
            const row = lookupRows[email];
            return { rows: row ? [row] : [] };
        }

        // users: query with RLS context active
        if (/from users where email.*sso_provider/i.test(s)) {
            const email = params[0] as string;
            const row = (usersRows as any)[email];
            return { rows: row ? [row] : [] };
        }

        return { rows: [] };
    };

    return {
        query: vi.fn(handleQuery),
        connect: vi.fn(async () => ({
            query: vi.fn(handleQuery),
            release: vi.fn(),
        })),
    };
}

// ── App factory ────────────────────────────────────────────────────────────────

async function buildLoginApp(
    poolOverrides?: Parameters<typeof buildMockPool>[0]
): Promise<{ app: FastifyInstance; pool: ReturnType<typeof buildMockPool> }> {
    const pool = buildMockPool(poolOverrides);
    const app = Fastify({ logger: false });
    app.register(fastifyJwt, { secret: JWT_SECRET });
    app.register(cookie, { secret: 'test-cookie-secret' });

    const requireAdminAuth = async (_req: any, reply: any) => {
        reply.status(401).send({ error: 'Unauthorized' });
    };
    const requireRole = (_roles: string[]) => async (_req: any, reply: any) => {
        reply.status(401).send({ error: 'Unauthorized' });
    };

    app.register(adminRoutes, { pgPool: pool as any, requireAdminAuth, requireRole });
    await app.ready();
    return { app, pool };
}

// ── Setup / Teardown ───────────────────────────────────────────────────────────

beforeAll(async () => {
    process.env.JWT_SECRET     = JWT_SECRET;
    process.env.SIGNING_SECRET = SIGN_SECRET;
    // cost=1 para velocidade — aceitável em testes (não em produção)
    passwordHash = await bcrypt.hash(VALID_PASS, 1);
});

afterAll(() => {
    delete process.env.JWT_SECRET;
    delete process.env.SIGNING_SECRET;
});

beforeEach(() => {
    capturedSql.length = 0;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('P-01: Login Endpoint — user_lookup isolation', () => {

    it('login com credenciais válidas de Org A retorna JWT com orgId = Org A', async () => {
        const { app } = await buildLoginApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_A, password: VALID_PASS },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.token).toBeTruthy();

        const claims = app.jwt.verify(body.token) as any;
        expect(claims.orgId).toBe(ORG_A_ID);
        expect(claims.userId).toBe(USER_A_ID);
        expect(claims.email).toBe(EMAIL_A);

        await app.close();
    });

    it('login com credenciais válidas de Org B retorna JWT com orgId = Org B (não Org A)', async () => {
        const { app } = await buildLoginApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_B, password: VALID_PASS },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        const claims = app.jwt.verify(body.token) as any;

        // Isolamento crítico: o JWT é bound ao org_id do usuário, não de outro tenant
        expect(claims.orgId).toBe(ORG_B_ID);
        expect(claims.orgId).not.toBe(ORG_A_ID);
        expect(claims.userId).toBe(USER_B_ID);

        await app.close();
    });

    it('email não existe em user_lookup → 401 sem revelar dados internos', async () => {
        const { app } = await buildLoginApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: 'attacker@evil.com', password: VALID_PASS },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe('Credenciais inválidas.');
        // user_lookup foi consultado mas não encontrou resultado
        expect(capturedSql.some(q => /from user_lookup where email/i.test(q.sql))).toBe(true);
        // users NÃO deve ter sido consultado (falha rápida no lookup)
        expect(capturedSql.some(q => /from users where email.*sso_provider/i.test(q.sql))).toBe(false);

        await app.close();
    });

    it('senha inválida → 401 (user_lookup retorna org, mas bcrypt falha)', async () => {
        const { app } = await buildLoginApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_A, password: 'WrongPassword!' },
        });

        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe('Credenciais inválidas.');

        await app.close();
    });

    it('ORDER crítico: user_lookup consultado ANTES de set_config — RLS corretamente ativo', async () => {
        const { app } = await buildLoginApp();

        await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_A, password: VALID_PASS },
        });

        // Verificar que user_lookup vem ANTES do set_config na sequência de queries
        const lookupIdx  = capturedSql.findIndex(q => /from user_lookup/i.test(q.sql));
        const setcfgIdx  = capturedSql.findIndex(q => /set_config/i.test(q.sql));
        const usersIdx   = capturedSql.findIndex(q => /from users where email/i.test(q.sql));

        expect(lookupIdx).toBeGreaterThanOrEqual(0);
        expect(setcfgIdx).toBeGreaterThanOrEqual(0);
        expect(usersIdx).toBeGreaterThanOrEqual(0);

        // Invariante P-01: lookup → set_config → users (ordem obrigatória)
        expect(lookupIdx).toBeLessThan(setcfgIdx);
        expect(setcfgIdx).toBeLessThan(usersIdx);

        await app.close();
    });

    it('set_config usa o org_id retornado pelo user_lookup (não valor do attacker)', async () => {
        const { app } = await buildLoginApp();

        await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_A, password: VALID_PASS },
        });

        const setcfgCall = capturedSql.find(q => /set_config/i.test(q.sql));
        expect(setcfgCall).toBeTruthy();
        // O set_config é chamado com o org_id da lookup — Org A
        expect(setcfgCall?.params).toContain(ORG_A_ID);
        // Nunca usa Org B no set_config de login de Org A
        expect(setcfgCall?.params).not.toContain(ORG_B_ID);

        await app.close();
    });

    it('usuario com requires_password_change → 403 com resetToken', async () => {
        const { app } = await buildLoginApp({
            usersRows: {
                [EMAIL_A]: {
                    id: USER_A_ID,
                    org_id: ORG_A_ID,
                    password_hash: passwordHash,
                    role: 'admin',
                    requires_password_change: true,
                },
            },
        });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: EMAIL_A, password: VALID_PASS },
        });

        expect(res.statusCode).toBe(403);
        const body = res.json();
        expect(body.requires_password_change).toBe(true);
        expect(body.resetToken).toBeTruthy();

        // Verifica que o resetToken é um JWT com resetOnly: true
        const decoded = app.jwt.verify(body.resetToken) as any;
        expect(decoded.resetOnly).toBe(true);
        expect(decoded.email).toBe(EMAIL_A);

        await app.close();
    });

    it('corpo com email inválido ou password ausente → 400 (Zod) sem consultar DB', async () => {
        // P-08: Zod validation fires BEFORE any DB query — malformed input returns 400, not 401.
        // The DB must still never be touched (capturedSql must remain empty).
        const { app } = await buildLoginApp();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/admin/login',
            payload: { email: '' },   // empty string fails email() + password missing
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('Validation failed');
        expect(Array.isArray(body.details)).toBe(true);
        // Nenhuma query ao DB deve ter sido executada
        expect(capturedSql.length).toBe(0);

        await app.close();
    });

});

describe('P-01: requireApiKey — api_key_lookup sem RLS', () => {

    it('api_key_lookup é consultada (não api_keys com IS NULL) ao autenticar via API key', async () => {
        // Este teste verifica o padrão de query em server.ts (requireApiKey).
        // Como server.ts não é registrado como plugin de adminRoutes, testamos
        // a invariante via análise de código (grep) + snapshot da query esperada.
        //
        // A prova definitiva é a migration 028 que remove IS NULL de api_keys_auth_policy:
        // qualquer query a api_keys sem set_config retorna 0 rows → auth falha.
        // Portanto, requireApiKey DEVE usar api_key_lookup (sem RLS) para funcionar.

        // Snapshot test: verifica que o arquivo server.ts contém a query correta
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const serverSrc = readFileSync(
            join(process.cwd(), 'src/server.ts'),
            'utf8'
        );

        // A query de autenticação deve usar api_key_lookup, não api_keys
        expect(serverSrc).toContain('api_key_lookup');
        expect(serverSrc).not.toMatch(/FROM api_keys WHERE key_hash/);

        // A migration 028 deve existir com a correção das policies
        const migration028 = readFileSync(
            join(process.cwd(), '028_create_user_lookup.sql'),
            'utf8'
        );
        expect(migration028).toContain('CREATE TABLE IF NOT EXISTS api_key_lookup');
        expect(migration028).toContain('sync_api_key_lookup');
        // O padrão de bypass é: nullif(current_setting(...), '') IS NULL [OR ...]
        // Pode aparecer em comentários — verifica ausência no SQL real (USING clause)
        expect(migration028).not.toMatch(/USING\s*\([^)]*IS NULL/i);
    });

    it('migration 028 remove IS NULL de users_login_policy e api_keys_auth_policy', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');

        const migration028 = readFileSync(
            join(process.cwd(), '028_create_user_lookup.sql'),
            'utf8'
        );

        // As duas policies recriadas NÃO devem conter IS NULL
        const policyBlock = migration028.split('-- ── 6.')[1];
        expect(policyBlock).toBeDefined();
        // Verifica ausência do padrão de bypass nas cláusulas USING — comentários são ok
        expect(policyBlock).not.toMatch(/USING\s*\([^)]*IS NULL/i);
        expect(policyBlock).toContain('users_login_policy');
        expect(policyBlock).toContain('api_keys_auth_policy');
    });

    it('021_fix_users_rls_for_login.sql foi corrigido para novos deploys (sem IS NULL)', async () => {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');

        const migration021 = readFileSync(
            join(process.cwd(), '021_fix_users_rls_for_login.sql'),
            'utf8'
        );

        // Nenhuma USING clause deve conter o padrão de bypass IS NULL
        expect(migration021).not.toMatch(/USING\s*\([^)]*IS NULL/i);
        // Deve conter as policies corretas
        expect(migration021).toContain('users_login_policy');
        expect(migration021).toContain('api_keys_auth_policy');
    });

});
