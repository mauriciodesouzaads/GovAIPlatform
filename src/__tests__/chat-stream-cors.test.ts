/**
 * FASE 13.5a2 — regression guard for chat SSE CORS headers.
 *
 * Before this fix, POST /v1/admin/chat/send/stream responded with 200
 * and valid SSE body but ZERO Access-Control-Allow-Origin headers,
 * causing Chrome to reject the response with TypeError: Failed to
 * fetch. This test locks down the contract so hijacked SSE always
 * echoes CORS when the request has a whitelisted Origin.
 *
 * See docs/STREAM_HANDLER_INVESTIGATION_20260422_2113.md and
 * docs/ADR-022-cors-on-hijacked-sse.md.
 */

import { describe, it, expect } from 'vitest';
import { buildCorsHeaders, getCorsAllowOrigins } from '../lib/cors-config';

describe('CORS config — single source of truth', () => {
    it('getCorsAllowOrigins returns the default dev triad', () => {
        const origins = getCorsAllowOrigins();
        expect(origins).toContain('http://localhost:3000');
        expect(origins).toContain('http://localhost:3001');
        expect(origins).toContain('http://localhost:3002');
    });

    it('getCorsAllowOrigins filters out empty ADMIN_UI_ORIGIN', () => {
        const origins = getCorsAllowOrigins();
        expect(origins.every(o => o.length > 0)).toBe(true);
    });

    it('buildCorsHeaders returns {} for undefined origin', () => {
        expect(buildCorsHeaders(undefined)).toEqual({});
    });

    it('buildCorsHeaders returns {} for non-allowed origin', () => {
        expect(buildCorsHeaders('https://evil.example')).toEqual({});
    });

    it('buildCorsHeaders echoes the origin with credentials + vary', () => {
        const headers = buildCorsHeaders('http://localhost:3001');
        expect(headers).toEqual({
            'Access-Control-Allow-Origin': 'http://localhost:3001',
            'Access-Control-Allow-Credentials': 'true',
            Vary: 'Origin',
        });
    });

    it('buildCorsHeaders respects ADMIN_UI_ORIGIN env var', () => {
        const prev = process.env.ADMIN_UI_ORIGIN;
        process.env.ADMIN_UI_ORIGIN = 'https://prod.govai.example';
        try {
            const headers = buildCorsHeaders('https://prod.govai.example');
            expect(headers['Access-Control-Allow-Origin']).toBe('https://prod.govai.example');
        } finally {
            if (prev === undefined) delete process.env.ADMIN_UI_ORIGIN;
            else process.env.ADMIN_UI_ORIGIN = prev;
        }
    });
});
