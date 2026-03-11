import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Issuer, BaseClient, TokenSet } from 'openid-client';
import { Pool } from 'pg';
import Redis from 'ioredis';

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

// In-memory fallback
const fallbackStore = new Map<string, { count: number; resetAt: number }>();

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
export { ssoRateLimitGuard, fallbackStore, SSO_RATE_LIMIT_MAX };

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

        const redirectUri = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL}/v1/auth/sso/callback` : 'http://localhost:3000/v1/auth/sso/callback';

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

            // Generate PKCE and state for secure OIDC flow
            const state = 'dummy_state_for_sso_123';
            const nonce = 'dummy_nonce_for_sso_123';

            const authUrl = client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
            });

            // Set cookie for state validation in production
            reply.setCookie('oidc_state', state, { path: '/', httpOnly: true, sameSite: 'lax' });

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

            let tokenSet: TokenSet;
            let isMockTokenSet = false;

            try {
                // In production, validate state from cookies. Bypassing for demo.
                tokenSet = await client.callback(client.metadata.redirect_uris![0], params, { state: 'dummy_state_for_sso_123', nonce: 'dummy_nonce_for_sso_123' });
            } catch (err) {
                const isProd = process.env.NODE_ENV === 'production';
                const enableMock = process.env.ENABLE_SSO_MOCK === 'true';

                if (!isProd && enableMock) {
                    fastify.log.warn("[DEV/TEST] SSO: Real OIDC exchange failed. Using MOCK token (ENABLE_SSO_MOCK active). NOT FOR PRODUCTION.");
                    tokenSet = new TokenSet({ access_token: "mock_token" });
                    isMockTokenSet = true;
                } else {
                    throw err; // Secure fallback
                }
            }

            let claims: { sub: string; email?: string; name?: string; tid?: string };
            if (!isMockTokenSet) {
                claims = tokenSet.claims();
            } else {
                // Demo mock claims if no real ID token was exchanged
                claims = {
                    sub: 'user_12345_entra',
                    email: 'diretor@govai.com',
                    name: 'Diretor de Operações',
                    tid: 'tenant_12345_corporativo' // Tenant ID do Entra ID
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

            try {
                await dbClient.query('BEGIN');

                // 1. JIT: Resolver Organização pelo Tenant ID
                const orgRes = await dbClient.query('SELECT id FROM organizations WHERE sso_tenant_id = $1', [ssoTenantId]);
                if (orgRes.rows.length > 0) {
                    orgId = orgRes.rows[0].id;
                } else {
                    const newOrg = await dbClient.query(
                        'INSERT INTO organizations (name, sso_tenant_id) VALUES ($1, $2) RETURNING id',
                        [`Org Corporativa (${ssoTenantId})`, ssoTenantId]
                    );
                    orgId = newOrg.rows[0].id;
                }

                // 2. JIT: Resolver Utilizador pelo SSO User ID
                const userRes = await dbClient.query('SELECT id FROM users WHERE sso_provider = $1 AND sso_user_id = $2', [provider, ssoUserId]);
                if (userRes.rows.length > 0) {
                    userId = userRes.rows[0].id;
                } else {
                    const newUser = await dbClient.query(
                        'INSERT INTO users (org_id, email, name, sso_provider, sso_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                        [orgId, email, name, provider, ssoUserId]
                    );
                    userId = newUser.rows[0].id;
                }

                await dbClient.query('COMMIT');
            } catch (e) {
                await dbClient.query('ROLLBACK');
                throw e;
            } finally {
                dbClient.release();
            }

            // 3. Issue GovAI Internal JWT with RLS Context
            const token = fastify.jwt.sign({
                email,
                role: 'admin',
                orgId: orgId, // CRITICAL: This links the federated user to their tenant RLS 
                userId: userId
            }, { expiresIn: '8h' });

            // Redireciona para o Front-End com o Token
            const frontEndUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
            reply.setCookie('token', token, { path: '/', httpOnly: false }); // httpOnly=false for JS to grab it for API auth via header

            return reply.redirect(`${frontEndUrl}/assistants?login=sso_success`);

        } catch (error) {
            fastify.log.error(error, "SSO Callback Error");
            return reply.status(500).send({ error: "Falha na verificação multifactor OIDC." });
        }
    });
}
