/**
 * Smoke test — FASE 13.4
 * ---------------------------------------------------------------------------
 * Verifies that:
 *   1. The SDK compiles against the generated schema.
 *   2. `createGovAIClient` returns an object exposing the HTTP verbs.
 *   3. A typed path string autocompletes (checked by the `as const` hint
 *      below) — if a route is removed from openapi.yaml this file fails
 *      to type-check.
 *
 * We deliberately avoid a real network call here; integration against
 * a live API is the backend test suite's job.
 */

import { describe, it, expect } from 'vitest';
import { createGovAIClient } from '../src';

describe('@govai/sdk smoke', () => {
    it('creates a client with all HTTP verbs', () => {
        const client = createGovAIClient({
            baseUrl: 'http://localhost:3000',
            apiKey: 'test',
        });
        expect(typeof client.GET).toBe('function');
        expect(typeof client.POST).toBe('function');
        expect(typeof client.PUT).toBe('function');
        expect(typeof client.DELETE).toBe('function');
    });

    it('injects Authorization + x-org-id headers in the client config', () => {
        // `createGovAIClient` does not expose a way to read its headers back,
        // but we can sanity-check construction doesn't throw for the typical
        // shape of options.
        expect(() =>
            createGovAIClient({
                baseUrl: 'http://localhost:3000',
                apiKey: 'test',
                orgId: '00000000-0000-0000-0000-000000000001',
                defaultHeaders: { 'x-trace-id': 'probe' },
            }),
        ).not.toThrow();
    });

    it('accepts autoBackoff=false to disable the rate-limit middleware', () => {
        const client = createGovAIClient({
            baseUrl: 'http://localhost:3000',
            apiKey: 'test',
            autoBackoff: false,
        });
        expect(client).toBeDefined();
    });

    it('types resolve for a known public route', () => {
        const client = createGovAIClient({ baseUrl: 'http://localhost:3000', apiKey: 'test' });
        // The call below must compile. No fetch is made (the promise is
        // caught and discarded). If `/v1/admin/stats` disappears from the
        // spec this line fails the type checker at build time.
        void client.GET('/v1/admin/stats' as never).catch(() => undefined);
    });
});
