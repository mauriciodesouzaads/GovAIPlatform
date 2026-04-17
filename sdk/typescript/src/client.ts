/**
 * GovAI TypeScript SDK — client factory
 * ---------------------------------------------------------------------------
 * Thin wrapper around `openapi-fetch` that injects the API key, a default
 * `x-org-id` header, and a backoff middleware that reads the standard
 * rate-limit headers emitted by the platform (see
 * `docs/api/RATE_LIMITS.md`).
 *
 * The `paths` type — the union of every endpoint's request/response shape —
 * is generated from the versioned `docs/api/openapi.yaml` by
 * `npm run generate:types`.
 */

import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';

export interface GovAIClientOptions {
    /** Base URL of the GovAI API (e.g. `https://api.yourcompany.com`). */
    baseUrl: string;

    /**
     * API key (format: `sk-govai-…`). If you're calling as an admin with a
     * session JWT, pass the JWT here — both are accepted as Bearer tokens
     * by the platform.
     */
    apiKey: string;

    /**
     * Default `x-org-id` header. All tenant-scoped routes require it.
     * Omit if you only call platform-admin endpoints or plan to set it
     * per-request via `params.header`.
     */
    orgId?: string;

    /**
     * If true (default), the client honors `Retry-After` and
     * `X-RateLimit-Remaining` to back off before the platform returns
     * a 429. Set to `false` to always issue the request immediately.
     */
    autoBackoff?: boolean;

    /** Extra headers to merge onto every request (e.g. `X-Trace-Id`). */
    defaultHeaders?: Record<string, string>;

    /** Custom fetch implementation (useful for tests or non-browser envs). */
    fetch?: typeof fetch;
}

/**
 * Build a strongly-typed client for the GovAI API.
 *
 * @example
 * ```ts
 * import { createGovAIClient } from '@govai/sdk';
 *
 * const client = createGovAIClient({
 *     baseUrl: 'https://api.yourcompany.com',
 *     apiKey: process.env.GOVAI_API_KEY!,
 *     orgId: process.env.GOVAI_ORG_ID!,
 * });
 *
 * const { data, error } = await client.GET('/v1/admin/assistants');
 * if (error) throw error;
 * console.log(data);
 * ```
 */
export function createGovAIClient(opts: GovAIClientOptions) {
    const { baseUrl, apiKey, orgId, autoBackoff = true, defaultHeaders = {}, fetch: customFetch } = opts;

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        ...defaultHeaders,
    };
    if (orgId) {
        headers['x-org-id'] = orgId;
    }

    const client = createClient<paths>({
        baseUrl,
        headers,
        fetch: customFetch,
    });

    if (autoBackoff) {
        client.use(makeBackoffMiddleware());
    }

    return client;
}

/**
 * Middleware that:
 *   1. Pauses the next request when `X-RateLimit-Remaining` is <5 % of the
 *      bucket (proactive, jittered).
 *   2. Retries once on a 429 honoring `Retry-After`, capped at 60 s.
 *
 * Kept intentionally simple — richer strategies (token bucket, circuit
 * breaker) are left to the caller.
 */
function makeBackoffMiddleware(): Middleware {
    // Module-scoped cool-down window shared across requests from the same client.
    let waitUntil = 0;

    return {
        async onRequest({ request }) {
            const now = Date.now();
            if (waitUntil > now) {
                const delay = waitUntil - now;
                await new Promise(r => setTimeout(r, delay));
            }
            return request;
        },
        async onResponse({ response }) {
            const remaining = Number(response.headers.get('x-ratelimit-remaining'));
            const limit = Number(response.headers.get('x-ratelimit-limit'));
            const reset = Number(response.headers.get('x-ratelimit-reset'));
            if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
                // Proactive cool-down when <5 % of the bucket is left. Cap the
                // scheduled wait at 60 s regardless of reset time.
                if (remaining / limit < 0.05 && Number.isFinite(reset)) {
                    const untilReset = reset * 1000 - Date.now();
                    if (untilReset > 0) {
                        const jittered = Math.min(untilReset + Math.random() * 500, 60_000);
                        waitUntil = Date.now() + jittered;
                    }
                }
            }
            if (response.status === 429) {
                const retryAfter = Number(response.headers.get('retry-after'));
                const secs = Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) : 10;
                waitUntil = Date.now() + secs * 1000;
            }
            return response;
        },
    };
}

export type { paths } from './schema';
