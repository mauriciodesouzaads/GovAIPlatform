import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Issuer, BaseClient, TokenSet } from 'openid-client';
import { Pool } from 'pg';
import Redis from 'ioredis';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// DT-E3: Redis-backed Rate Limiter for SSO endpoints (horizontal scaling)
// Falls back to in-memory Map if Redis is unavailable
// ---------------------------------------------------------------------------
const SSO_RATE_LIMIT_WINDOW_SEC = 60; // 1 minute
const SSO_RATE_LIMIT_MAX = 10; // max 10 requests per IP per minute

let redis: Redis | null = null;
try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    redis.connect().catch(() => { redis = null; }); // silent fallback
} catch { redis = null; }

// In-memory fallback for rate limiting
const fallbackStore = new Map<string, { count: number; resetAt: number }>();

// ---------------------------------------------------------------------------
// OIDC State/Nonce store — prevents CSRF (SEC-OIDC-01)
// Primary: Redis with 10-min TTL; fallback: in-memory Map with expiry check
// ---------------------------------------------------------------------------
const oidcStateStore = new Map<string, { nonce: string; expiresAt: number }>();

// Periodic in-memory state cleanup every 5 minutes to prevent unbounded growth
const _stateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of oidcStateStore.entries()) {
        if (now > val.expiresAt) oidcStateStore.delete(key);
    }
}, 300_000);
// Unref prevents this timer from keeping the process alive in tests
if (_stateCleanupTimer.unref) _stateCleanupTimer.unref();

async function ssoRateLimitGuard(request: FastifyRequest, reply: FastifyReply) {
    const ip = request.ip || 'unknown';
    const key = `sso_rl:${ip}`;

    // Try Redis first
    if (redis && redis.status === 'ready') {
        try {
            const count = await redis.incr(key);
            if (count === 1) await redis.expire(key, SSO_RATE_LIMIT_WINDOW_SEC);
            if (count > SSO_RATE_LIMIT_MAX) {
                return reply.status(429).send({ error: 'Rate limit exceeded. Too many SSO requests. Try again in 1 minute.' });
            }
            return; // OK
        } catch { /* fall through to in-memory */ }
    }

    // In-memory fallback
    const now = Date.now();
    const entry = fallbackStore.get(ip);
    if (!entry || now > entry.resetAt) {
        fallbackStore.set(ip, { count: 1, resetAt: now + SSO_RATE_LIMIT_WINDOW_SEC * 1000 });
        return;
    }
    entry.count++;
    if (entry.count > SSO_RATE_LIMIT_MAX) {
        return reply.status(429).send({ error: 'Rate limit exceeded. Too many SSO requests. Try again in 1 minute.' });
    }
}

// Export for testing
export { ssoRateLimitGuard, fallbackStore, oidcStateStore, SSO_RATE_LIMIT_MAX };

export async function registerOidcRoutes(fastify: FastifyInstance, pgPool: Pool) {
    let oidcClient: BaseClient | null = null;

    // Load OIDC Client dynamically (lazy load to not crash dev environment if vars are missing)
    const initClient = async () => {
        if (oidcClient) return oidcClient;
        const issuerUrl = process.env.OIDC_ISSUER_URL;
        const clientId = process.env.OIDC_CLIENT_ID;
        const clientSecret = process.env.OIDC_CLIENT_SECRET;

        if (!issuerUrl || !clientId || !clientSecret) {
            throw new Error('OIDC configuration incomplete.');
        }

        const redirectUri = process.env.APP_BASE_URL
            ? `${process.env.APP_BASE_URL}/v1/auth/sso/callback`
            : 'http://localhost:3000/v1/auth/sso/callback';

        const issuer = await Issuer.discover(issuerUrl);
        oidcClient = new issuer.Client({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: [redirectUri],
            response_types: ['code']
        });
        return oidcClient;
    };

    fastify.get('/v1/auth/sso/login', { preHandler: [ssoRateLimitGuard] }, async (request, reply) => {
        try {
            const client = await initClient();
            const provider = (request.query as any).provider || 'entra_id';

            if (!['entra_id', 'okta'].includes(provider)) {
                return reply.status(400).send({ error: 'Provedor SSO não suportado ou em branco.' });
            }

            // SEC-OIDC-01: Generate cryptographically random state and nonce per request.
            // State prevents CSRF — must be validated on callback.
            // Nonce prevents replay attacks on the ID token.
            const state = crypto.randomBytes(32).toString('hex');
            const nonce = crypto.randomBytes(32).toString('hex');
            const OIDC_STATE_TTL_SEC = 600; // 10 minutes
            const stateKey = `oidc_state:${state}`;

            // Store state→nonce mapping. Redis is primary; in-memory is fallback.
            let storedInRedis = false;
            if (redis && redis.status === 'ready') {
                try {
                    await redis.setex(stateKey, OIDC_STATE_TTL_SEC, nonce);
                    storedInRedis = true;
                } catch { /* fall through */ }
            }
            if (!storedInRedis) {
                oidcStateStore.set(state, {
                    nonce,
                    expiresAt: Date.now() + OIDC_STATE_TTL_SEC * 1000,
                });
            }

            const authUrl = client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
            });

            // Set httpOnly cookie so the state value is inaccessible to JS
            // and bound to this specific browser session.
            reply.setCookie('oidc_state', state, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: OIDC_STATE_TTL_SEC,
            });

            return reply.redirect(authUrl);
        } catch (error) {
            fastify.log.error(error, "SSO Login Initialization Failed");
            return reply.status(500).send({ error: "Serviço de SSO indisponível." });
        }
    });

    fastify.get('/v1/auth/sso/callback', { preHandler: [ssoRateLimitGuard] }, async (request, reply) => {
        try {
            const client = await initClient();
            const params = client.callbackParams(request.raw as any);

            // Mock mode: allowed only in non-production environments with explicit opt-in.
            const isMockMode = process.env.NODE_ENV !== 'production' && process.env.ENABLE_SSO_MOCK === 'true';

            let tokenSet: TokenSet;
            let isMockTokenSet = false;

            if (!isMockMode) {
                // SEC-OIDC-01: Validate CSRF state before touching the OIDC token exchange.
                const cookieState = (request.cookies as any)?.oidc_state as string | undefined;

                if (!cookieState) {
                    return reply.status(400).send({
                        error: 'Estado de sessão OIDC ausente. Inicie o fluxo de login novamente.',
                    });
                }

                // Retrieve stored nonce — one-time use (consumed on first read).
                let storedNonce: string | null = null;
                const stateKey = `oidc_state:${cookieState}`;

                if (redis && redis.status === 'ready') {
                    try {
                        storedNonce = await redis.get(stateKey);
                        if (storedNonce) await redis.del(stateKey);
                    } catch { /* fall through to in-memory */ }
                }

                if (!storedNonce) {
                    const entry = oidcStateStore.get(cookieState);
                    if (entry && Date.now() < entry.expiresAt) {
                        storedNonce = entry.nonce;
                        oidcStateStore.delete(cookieState); // one-time use
                    }
                }

                if (!storedNonce) {
                    return reply.status(400).send({
                        error: 'Estado de autenticação inválido, expirado ou já utilizado. Inicie o login novamente.',
                    });
                }

                // Exchange the code using the validated state+nonce from storage.
                tokenSet = await client.callback(
                    client.metadata.redirect_uris![0],
                    params,
                    { state: cookieState, nonce: storedNonce }
                );
            } else {
                // Dev/test mock path
                try {
                    tokenSet = await client.callback(client.metadata.redirect_uris![0], params);
                } catch (err) {
                    fastify.log.warn("[DEV/TEST] SSO: Real OIDC exchange failed. Using MOCK token (ENABLE_SSO_MOCK active). NOT FOR PRODUCTION.");
                    tokenSet = new TokenSet({ access_token: "mock_token" });
                    isMockTokenSet = true;
                }
            }

            let claims: { sub: string; email?: string; name?: string; tid?: string };
            if (!isMockTokenSet) {
                claims = tokenSet.claims();
            } else {
                claims = {
                    sub: 'user_12345_entra',
                    email: 'diretor@govai.com',
                    name: 'Diretor de Operações',
                    tid: 'tenant_12345_corporativo',
                };
            }

            const ssoUserId = claims.sub;
            const ssoTenantId = claims.tid || 'default_local_tenant';
            const email = claims.email as string;
            const name = claims.name || email;
            const provider = 'entra_id';

            const dbClient = await pgPool.connect();
            let orgId: string;
            let userId: string;
            let userRole: string = 'operator'; // SEC-SSO-02: safe default — admin role must be explicitly granted

            try {
                await dbClient.query('BEGIN');

                // 1. JIT: Resolve Organization by Tenant ID
                const orgRes = await dbClient.query(
                    'SELECT id FROM organizations WHERE sso_tenant_id = $1',
                    [ssoTenantId]
                );
                if (orgRes.rows.length > 0) {
                    orgId = orgRes.rows[0].id;
                } else {
                    const newOrg = await dbClient.query(
                        'INSERT INTO organizations (name, sso_tenant_id) VALUES ($1, $2) RETURNING id',
                        [`Org Corporativa (${ssoTenantId})`, ssoTenantId]
                    );
                    orgId = newOrg.rows[0].id;
                }

                // 2. JIT: Resolve User by SSO User ID — preserve existing role, default new users to 'operator'
                const userRes = await dbClient.query(
                    'SELECT id, role FROM users WHERE sso_provider = $1 AND sso_user_id = $2',
                    [provider, ssoUserId]
                );
                if (userRes.rows.length > 0) {
                    userId = userRes.rows[0].id;
                    userRole = userRes.rows[0].role || 'operator';
                } else {
                    // New user: INSERT without specifying role → DB default 'operator' applies.
                    // An admin can elevate this user's role via the admin panel after first login.
                    const newUser = await dbClient.query(
                        'INSERT INTO users (org_id, email, name, sso_provider, sso_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, role',
                        [orgId, email, name, provider, ssoUserId]
                    );
                    userId = newUser.rows[0].id;
                    userRole = newUser.rows[0].role || 'operator';
                }

                await dbClient.query('COMMIT');
            } catch (e) {
                await dbClient.query('ROLLBACK');
                throw e;
            } finally {
                dbClient.release();
            }

            // 3. Issue GovAI Internal JWT with RLS Context
            // Role comes from the database — never hardcoded to 'admin'.
            const token = fastify.jwt.sign({
                email,
                role: userRole,
                orgId,
                userId,
            }, { expiresIn: '8h' });

            const frontEndUrl = process.env.FRONTEND_URL || 'http://localhost:3001';

            // Token cookie: httpOnly so JS cannot steal it via XSS.
            // The frontend reads role/email from the /v1/admin/me endpoint (Etapa 3).
            reply.setCookie('token', token, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 8 * 60 * 60,
            });

            return reply.redirect(`${frontEndUrl}/assistants?login=sso_success`);

        } catch (error) {
            fastify.log.error(error, "SSO Callback Error");
            return reply.status(500).send({ error: "Falha na verificação multifactor OIDC." });
        }
    });
}
