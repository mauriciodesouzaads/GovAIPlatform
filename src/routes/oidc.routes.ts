import { FastifyInstance } from 'fastify';
import { Issuer, generators } from 'openid-client';
import { Pool } from 'pg';
import crypto from 'crypto';
import { redisCache } from '../lib/redis';

function isMicrosoftConfigured(): boolean {
    return !!(
        process.env.AZURE_CLIENT_ID &&
        process.env.AZURE_CLIENT_SECRET &&
        process.env.AZURE_TENANT_ID
    );
}

function isOktaConfigured(): boolean {
    return !!(
        process.env.OKTA_CLIENT_ID &&
        process.env.OKTA_CLIENT_SECRET &&
        process.env.OKTA_DOMAIN
    );
}

const pkceStore = new Map<string, { codeVerifier: string; nonce: string; expiresAt: number }>();
const _pkceCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pkceStore.entries()) {
        if (now > v.expiresAt) pkceStore.delete(k);
    }
}, 300_000);
if (_pkceCleanup.unref) _pkceCleanup.unref();

const PKCE_TTL_MS = 10 * 60 * 1000;
const FRONTEND_AUTH_CODE_TTL_SECONDS = 60;

export { isMicrosoftConfigured, isOktaConfigured, pkceStore };

function callbackUrl(base: string, provider: 'microsoft' | 'okta'): string {
    const root = (base || 'http://localhost:3000').replace(/\/$/, '');
    return `${root}/v1/auth/oidc/${provider}/callback`;
}

function frontendUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/$/, '');
}

function oktaIssuerUrl(): string {
    const domain = (process.env.OKTA_DOMAIN || '').replace(/\/$/, '');
    return domain.includes('/oauth2/') ? domain : `${domain}/oauth2/default`;
}

async function resolveOrgIdForSsoTenant(pgPool: Pool, ssoTenantId: string): Promise<string | null> {
    const res = await pgPool.query(
        'SELECT org_id FROM org_sso_lookup WHERE sso_tenant_id = $1 LIMIT 1',
        [ssoTenantId]
    );
    return res.rows[0]?.org_id || null;
}

async function resolveOrProvisionSsoUser(
    pgPool: Pool,
    params: {
        orgId: string;
        provider: 'entra_id' | 'okta';
        subject: string;
        email: string;
        name: string;
    }
): Promise<{ userId: string; role: string }> {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [params.orgId]);

        const exact = await client.query(
            `SELECT id, role
             FROM users
             WHERE org_id = $1 AND sso_provider = $2 AND sso_user_id = $3
             LIMIT 1`,
            [params.orgId, params.provider, params.subject]
        );
        if ((exact.rowCount ?? 0) > 0) {
            await client.query(
                `UPDATE users
                 SET email = $1, name = $2, status = 'active'
                 WHERE id = $3 AND org_id = $4`,
                [params.email, params.name, exact.rows[0].id, params.orgId]
            );
            await client.query('COMMIT');
            return { userId: exact.rows[0].id, role: exact.rows[0].role };
        }

        const byEmail = await client.query(
            `SELECT id, role, sso_provider, sso_user_id
             FROM users
             WHERE org_id = $1 AND LOWER(email) = LOWER($2)
             LIMIT 1`,
            [params.orgId, params.email]
        );

        if ((byEmail.rowCount ?? 0) > 0) {
            const current = byEmail.rows[0];
            if (current.sso_provider !== 'local' && (current.sso_provider !== params.provider || current.sso_user_id !== params.subject)) {
                await client.query('ROLLBACK');
                throw new Error('Este e-mail já está vinculado a outro provedor de identidade nesta organização.');
            }

            await client.query(
                `UPDATE users
                 SET sso_provider = $1,
                     sso_user_id = $2,
                     name = $3,
                     status = 'active'
                 WHERE id = $4 AND org_id = $5`,
                [params.provider, params.subject, params.name, current.id, params.orgId]
            );
            await client.query('COMMIT');
            return { userId: current.id, role: current.role };
        }

        const inserted = await client.query(
            `INSERT INTO users (org_id, email, name, sso_provider, sso_user_id, password_hash, requires_password_change, role, status)
             VALUES ($1, $2, $3, $4, $5, NULL, FALSE, 'operator', 'active')
             RETURNING id, role`,
            [params.orgId, params.email, params.name, params.provider, params.subject]
        );
        await client.query('COMMIT');
        return { userId: inserted.rows[0].id, role: inserted.rows[0].role };
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        throw error;
    } finally {
        client.release();
    }
}

async function storeFrontendAuthCode(token: string, provider: 'microsoft' | 'okta'): Promise<string> {
    const authCode = crypto.randomBytes(32).toString('hex');
    await redisCache.set(
        `oidc:frontend:${authCode}`,
        JSON.stringify({ token, provider }),
        'EX',
        FRONTEND_AUTH_CODE_TTL_SECONDS,
        'NX'
    );
    return authCode;
}

async function consumeFrontendAuthCode(code: string): Promise<{ token: string; provider: string } | null> {
    const raw = await redisCache.eval(
        `local value = redis.call('GET', KEYS[1]);
         if value then
           redis.call('DEL', KEYS[1]);
         end
         return value`,
        1,
        `oidc:frontend:${code}`
    );
    if (!raw || typeof raw !== 'string') return null;
    return JSON.parse(raw) as { token: string; provider: string };
}

async function buildGovAiToken(
    fastify: FastifyInstance,
    pgPool: Pool,
    params: {
        provider: 'entra_id' | 'okta';
        email: string;
        name: string;
        subject: string;
        ssoTenantId: string;
    }
): Promise<string> {
    const orgId = await resolveOrgIdForSsoTenant(pgPool, params.ssoTenantId);
    if (!orgId) {
        throw new Error('OIDC_TENANT_NOT_AUTHORIZED');
    }

    const { userId, role } = await resolveOrProvisionSsoUser(pgPool, {
        orgId,
        provider: params.provider,
        subject: params.subject,
        email: params.email,
        name: params.name,
    });

    return fastify.jwt.sign(
        { email: params.email, role, orgId, userId, ssoProvider: params.provider },
        { expiresIn: '8h' }
    );
}

export default async function oidcRoutes(fastify: FastifyInstance, opts: { pgPool: Pool }): Promise<void> {
    const { pgPool } = opts;

    fastify.post('/v1/auth/oidc/session', async (request, reply) => {
        const body = (request.body || {}) as Record<string, unknown>;
        const code = typeof body.code === 'string' ? body.code : '';
        if (!code || code.length < 16) {
            return reply.status(400).send({ error: 'OIDC authorization code inválido.' });
        }

        const session = await consumeFrontendAuthCode(code);
        if (!session) {
            return reply.status(410).send({ error: 'OIDC authorization code expirado ou já consumido.' });
        }

        reply.header('Cache-Control', 'no-store');
        return reply.send({ token: session.token, provider: session.provider });
    });

    fastify.get('/v1/auth/oidc/microsoft', async (_request, reply) => {
        if (!isMicrosoftConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'microsoft',
                hint: 'Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID',
            });
        }

        try {
            const tenantId = process.env.AZURE_TENANT_ID!;
            const issuer = await Issuer.discover(`https://login.microsoftonline.com/${tenantId}/v2.0`);
            const client = new issuer.Client({
                client_id: process.env.AZURE_CLIENT_ID!,
                client_secret: process.env.AZURE_CLIENT_SECRET!,
                redirect_uris: [callbackUrl(process.env.APP_BASE_URL!, 'microsoft')],
                response_types: ['code'],
            });

            const state = crypto.randomBytes(32).toString('hex');
            const nonce = crypto.randomBytes(32).toString('hex');
            const codeVerifier = generators.codeVerifier();
            const codeChallenge = generators.codeChallenge(codeVerifier);
            pkceStore.set(state, { codeVerifier, nonce, expiresAt: Date.now() + PKCE_TTL_MS });

            reply.setCookie('oidc_ms_state', state, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 600,
            });

            return reply.redirect(client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            }));
        } catch (err) {
            fastify.log.error(err, '[OIDC/Microsoft] Failed to initiate login');
            return reply.status(503).send({ error: 'Microsoft OIDC service unavailable' });
        }
    });

    fastify.get('/v1/auth/oidc/microsoft/callback', async (request, reply) => {
        if (!isMicrosoftConfigured()) {
            return reply.status(501).send({ error: 'OIDC not configured', provider: 'microsoft' });
        }

        const { code, state, error: authError } = request.query as Record<string, string>;
        if (authError) {
            return reply.redirect(`${frontendUrl()}/login?error=${encodeURIComponent(authError)}`);
        }
        if (!code) return reply.status(400).send({ error: 'Authorization code missing' });
        if (!state) return reply.status(400).send({ error: 'State parameter missing' });

        const cookieState = (request.cookies as Record<string, string>).oidc_ms_state;
        if (!cookieState || cookieState !== state) {
            return reply.status(400).send({ error: 'Invalid or missing CSRF state' });
        }

        const pkce = pkceStore.get(state);
        if (!pkce || Date.now() > pkce.expiresAt) {
            pkceStore.delete(state);
            return reply.status(400).send({ error: 'PKCE state expired or not found — restart login' });
        }
        pkceStore.delete(state);

        try {
            const tenantId = process.env.AZURE_TENANT_ID!;
            const issuer = await Issuer.discover(`https://login.microsoftonline.com/${tenantId}/v2.0`);
            const redirectUri = callbackUrl(process.env.APP_BASE_URL!, 'microsoft');
            const client = new issuer.Client({
                client_id: process.env.AZURE_CLIENT_ID!,
                client_secret: process.env.AZURE_CLIENT_SECRET!,
                redirect_uris: [redirectUri],
                response_types: ['code'],
            });

            const tokenSet = await client.callback(redirectUri, { code, state }, {
                state,
                nonce: pkce.nonce,
                code_verifier: pkce.codeVerifier,
            });

            const claims = tokenSet.claims();
            const email = ((claims.email as string) || (claims.preferred_username as string) || '').trim().toLowerCase();
            const name = ((claims.name as string) || email).trim();
            const subject = String(claims.sub || '').trim();
            const ssoTenantId = String(claims.tid || '').trim();

            if (!email || !subject || !ssoTenantId) {
                return reply.redirect(`${frontendUrl()}/login?error=identity_claims_incomplete`);
            }

            const token = await buildGovAiToken(fastify, pgPool, {
                provider: 'entra_id',
                email,
                name,
                subject,
                ssoTenantId,
            });
            const authCode = await storeFrontendAuthCode(token, 'microsoft');
            return reply.redirect(`${frontendUrl()}/login?auth_code=${authCode}&provider=microsoft`);
        } catch (err: any) {
            fastify.log.error(err, '[OIDC/Microsoft] Callback token exchange failed');
            const errorCode = err?.message === 'OIDC_TENANT_NOT_AUTHORIZED'
                ? 'tenant_not_authorized'
                : 'microsoft_auth_failed';
            return reply.redirect(`${frontendUrl()}/login?error=${errorCode}`);
        }
    });

    fastify.get('/v1/auth/oidc/okta', async (_request, reply) => {
        if (!isOktaConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'okta',
                hint: 'Set OKTA_CLIENT_ID, OKTA_CLIENT_SECRET and OKTA_DOMAIN',
            });
        }

        try {
            const issuer = await Issuer.discover(oktaIssuerUrl());
            const client = new issuer.Client({
                client_id: process.env.OKTA_CLIENT_ID!,
                client_secret: process.env.OKTA_CLIENT_SECRET!,
                redirect_uris: [callbackUrl(process.env.APP_BASE_URL!, 'okta')],
                response_types: ['code'],
            });

            const state = crypto.randomBytes(32).toString('hex');
            const nonce = crypto.randomBytes(32).toString('hex');
            const codeVerifier = generators.codeVerifier();
            const codeChallenge = generators.codeChallenge(codeVerifier);
            pkceStore.set(state, { codeVerifier, nonce, expiresAt: Date.now() + PKCE_TTL_MS });

            reply.setCookie('oidc_okta_state', state, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 600,
            });

            return reply.redirect(client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            }));
        } catch (err) {
            fastify.log.error(err, '[OIDC/Okta] Failed to initiate login');
            return reply.status(503).send({ error: 'Okta OIDC service unavailable' });
        }
    });

    fastify.get('/v1/auth/oidc/okta/callback', async (request, reply) => {
        if (!isOktaConfigured()) {
            return reply.status(501).send({ error: 'OIDC not configured', provider: 'okta' });
        }

        const { code, state, error: authError } = request.query as Record<string, string>;
        if (authError) {
            return reply.redirect(`${frontendUrl()}/login?error=${encodeURIComponent(authError)}`);
        }
        if (!code) return reply.status(400).send({ error: 'Authorization code missing' });
        if (!state) return reply.status(400).send({ error: 'State parameter missing' });

        const cookieState = (request.cookies as Record<string, string>).oidc_okta_state;
        if (!cookieState || cookieState !== state) {
            return reply.status(400).send({ error: 'Invalid or missing CSRF state' });
        }

        const pkce = pkceStore.get(state);
        if (!pkce || Date.now() > pkce.expiresAt) {
            pkceStore.delete(state);
            return reply.status(400).send({ error: 'PKCE state expired or not found — restart login' });
        }
        pkceStore.delete(state);

        try {
            const issuer = await Issuer.discover(oktaIssuerUrl());
            const redirectUri = callbackUrl(process.env.APP_BASE_URL!, 'okta');
            const client = new issuer.Client({
                client_id: process.env.OKTA_CLIENT_ID!,
                client_secret: process.env.OKTA_CLIENT_SECRET!,
                redirect_uris: [redirectUri],
                response_types: ['code'],
            });

            const tokenSet = await client.callback(redirectUri, { code, state }, {
                state,
                nonce: pkce.nonce,
                code_verifier: pkce.codeVerifier,
            });

            const claims = tokenSet.claims();
            const email = ((claims.email as string) || (claims.preferred_username as string) || '').trim().toLowerCase();
            const name = ((claims.name as string) || email).trim();
            const subject = String(claims.sub || '').trim();
            const ssoTenantId = String((claims.iss as string) || oktaIssuerUrl()).replace(/\/$/, '');

            if (!email || !subject || !ssoTenantId) {
                return reply.redirect(`${frontendUrl()}/login?error=identity_claims_incomplete`);
            }

            const token = await buildGovAiToken(fastify, pgPool, {
                provider: 'okta',
                email,
                name,
                subject,
                ssoTenantId,
            });
            const authCode = await storeFrontendAuthCode(token, 'okta');
            return reply.redirect(`${frontendUrl()}/login?auth_code=${authCode}&provider=okta`);
        } catch (err: any) {
            fastify.log.error(err, '[OIDC/Okta] Callback token exchange failed');
            const errorCode = err?.message === 'OIDC_TENANT_NOT_AUTHORIZED'
                ? 'tenant_not_authorized'
                : 'okta_auth_failed';
            return reply.redirect(`${frontendUrl()}/login?error=${errorCode}`);
        }
    });
}
