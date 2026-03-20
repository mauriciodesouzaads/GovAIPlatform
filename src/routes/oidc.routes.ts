import { FastifyInstance } from 'fastify';
import { Issuer, generators } from 'openid-client';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// GOVAI S12 — Dedicated OIDC routes for Microsoft Entra ID and Okta
//
// Design decisions:
//  - Each provider has its own separate env vars (no shared OIDC_* vars)
//  - Routes return 501 gracefully when env vars are absent (no crash on startup)
//  - PKCE (code_challenge + code_verifier) for public-client safety
//  - State + nonce stored in httpOnly cookie (CSRF protection)
//  - Callback validates state before token exchange
// ---------------------------------------------------------------------------

// ── Env-var guards ──────────────────────────────────────────────────────────

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

// ── In-memory PKCE state store (code_verifier + nonce per state) ────────────
// Keyed by `state` value. Entries expire after 10 minutes.
const pkceStore = new Map<string, { codeVerifier: string; nonce: string; expiresAt: number }>();

// Periodic cleanup so the Map cannot grow unboundedly
const _pkceCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pkceStore.entries()) {
        if (now > v.expiresAt) pkceStore.delete(k);
    }
}, 300_000);
if (_pkceCleanup.unref) _pkceCleanup.unref();

const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Export for testing
export { isMicrosoftConfigured, isOktaConfigured, pkceStore };

// ── Shared helpers ──────────────────────────────────────────────────────────

function callbackUrl(base: string, provider: 'microsoft' | 'okta'): string {
    const root = (base || 'http://localhost:3000').replace(/\/$/, '');
    return `${root}/v1/auth/oidc/${provider}/callback`;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export default async function oidcRoutes(fastify: FastifyInstance): Promise<void> {

    // ── Microsoft Entra ID ──────────────────────────────────────────────────

    /**
     * GET /v1/auth/oidc/microsoft
     * Initiates PKCE authorization flow with Microsoft Entra ID.
     * Returns 501 when AZURE_* vars are not configured.
     */
    fastify.get('/v1/auth/oidc/microsoft', async (request, reply) => {
        if (!isMicrosoftConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'microsoft',
                hint: 'Set AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_TENANT_ID',
            });
        }

        try {
            const tenantId = process.env.AZURE_TENANT_ID!;
            const issuerUrl = `https://login.microsoftonline.com/${tenantId}/v2.0`;
            const issuer = await Issuer.discover(issuerUrl);

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

            const authUrl = client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            });

            return reply.redirect(authUrl);
        } catch (err) {
            fastify.log.error(err, '[OIDC/Microsoft] Failed to initiate login');
            return reply.status(503).send({ error: 'Microsoft OIDC service unavailable' });
        }
    });

    /**
     * GET /v1/auth/oidc/microsoft/callback
     * Receives the authorization code from Microsoft, exchanges it for tokens,
     * issues a GovAI JWT and redirects to the admin UI.
     */
    fastify.get('/v1/auth/oidc/microsoft/callback', async (request, reply) => {
        if (!isMicrosoftConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'microsoft',
            });
        }

        const { code, state, error: authError } = request.query as Record<string, string>;

        if (authError) {
            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            return reply.redirect(`${frontEnd}/login?error=${encodeURIComponent(authError)}`);
        }

        if (!code) {
            return reply.status(400).send({ error: 'Authorization code missing' });
        }

        if (!state) {
            return reply.status(400).send({ error: 'State parameter missing' });
        }

        const cookieState = (request.cookies as Record<string, string>).oidc_ms_state;
        if (!cookieState || cookieState !== state) {
            return reply.status(400).send({ error: 'Invalid or missing CSRF state' });
        }

        const pkce = pkceStore.get(state);
        if (!pkce || Date.now() > pkce.expiresAt) {
            pkceStore.delete(state);
            return reply.status(400).send({ error: 'PKCE state expired or not found — restart login' });
        }
        pkceStore.delete(state); // one-time use

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
            const email = (claims.email as string) || (claims.preferred_username as string) || '';
            const name = (claims.name as string) || email;

            const token = fastify.jwt.sign(
                { email, role: 'operator', orgId: null, userId: null, ssoProvider: 'microsoft' },
                { expiresIn: '8h' }
            );

            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            reply.setCookie('token', token, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 8 * 60 * 60,
            });

            return reply.redirect(`${frontEnd}/assistants?login=sso_success&provider=microsoft&name=${encodeURIComponent(name)}`);
        } catch (err) {
            fastify.log.error(err, '[OIDC/Microsoft] Callback token exchange failed');
            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            return reply.redirect(`${frontEnd}/login?error=microsoft_auth_failed`);
        }
    });

    // ── Okta ────────────────────────────────────────────────────────────────

    /**
     * GET /v1/auth/oidc/okta
     * Initiates PKCE authorization flow with Okta.
     * Returns 501 when OKTA_* vars are not configured.
     */
    fastify.get('/v1/auth/oidc/okta', async (request, reply) => {
        if (!isOktaConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'okta',
                hint: 'Set OKTA_CLIENT_ID, OKTA_CLIENT_SECRET and OKTA_DOMAIN',
            });
        }

        try {
            const domain = process.env.OKTA_DOMAIN!.replace(/\/$/, '');
            const issuerUrl = domain.includes('/oauth2/')
                ? domain
                : `${domain}/oauth2/default`;

            const issuer = await Issuer.discover(issuerUrl);
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

            const authUrl = client.authorizationUrl({
                scope: 'openid profile email',
                state,
                nonce,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            });

            return reply.redirect(authUrl);
        } catch (err) {
            fastify.log.error(err, '[OIDC/Okta] Failed to initiate login');
            return reply.status(503).send({ error: 'Okta OIDC service unavailable' });
        }
    });

    /**
     * GET /v1/auth/oidc/okta/callback
     * Receives the authorization code from Okta, exchanges it for tokens,
     * issues a GovAI JWT and redirects to the admin UI.
     */
    fastify.get('/v1/auth/oidc/okta/callback', async (request, reply) => {
        if (!isOktaConfigured()) {
            return reply.status(501).send({
                error: 'OIDC not configured',
                provider: 'okta',
            });
        }

        const { code, state, error: authError } = request.query as Record<string, string>;

        if (authError) {
            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            return reply.redirect(`${frontEnd}/login?error=${encodeURIComponent(authError)}`);
        }

        if (!code) {
            return reply.status(400).send({ error: 'Authorization code missing' });
        }

        if (!state) {
            return reply.status(400).send({ error: 'State parameter missing' });
        }

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
            const domain = process.env.OKTA_DOMAIN!.replace(/\/$/, '');
            const issuerUrl = domain.includes('/oauth2/') ? domain : `${domain}/oauth2/default`;
            const issuer = await Issuer.discover(issuerUrl);
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
            const email = (claims.email as string) || (claims.preferred_username as string) || '';
            const name = (claims.name as string) || email;

            const token = fastify.jwt.sign(
                { email, role: 'operator', orgId: null, userId: null, ssoProvider: 'okta' },
                { expiresIn: '8h' }
            );

            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            reply.setCookie('token', token, {
                path: '/',
                httpOnly: true,
                sameSite: 'lax',
                secure: process.env.NODE_ENV === 'production',
                maxAge: 8 * 60 * 60,
            });

            return reply.redirect(`${frontEnd}/assistants?login=sso_success&provider=okta&name=${encodeURIComponent(name)}`);
        } catch (err) {
            fastify.log.error(err, '[OIDC/Okta] Callback token exchange failed');
            const frontEnd = process.env.FRONTEND_URL || 'http://localhost:3001';
            return reply.redirect(`${frontEnd}/login?error=okta_auth_failed`);
        }
    });
}
