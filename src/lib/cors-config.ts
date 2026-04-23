/**
 * CORS allow-list — single source of truth consumed by BOTH the global
 * @fastify/cors plugin registration (server.ts) AND the hijacked SSE
 * route (chat.routes.ts → /v1/admin/chat/send/stream).
 *
 * Why: `reply.hijack()` bypasses Fastify's onSend pipeline, which is
 * where @fastify/cors injects Access-Control-Allow-Origin. Streaming
 * routes must replicate that header manually — but from the SAME list,
 * otherwise the two places drift and CORS silently breaks again.
 *
 * See docs/STREAM_HANDLER_INVESTIGATION_20260422_2113.md for repro and
 * docs/ADR-022-cors-on-hijacked-sse.md for the decision record.
 */

export function getCorsAllowOrigins(): string[] {
    return [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:3002',
        process.env.ADMIN_UI_ORIGIN || '',
    ].filter(Boolean);
}

/**
 * Given a request's `Origin` header, returns the CORS headers that
 * should be written on the response — or an empty object if the origin
 * is not allow-listed (in which case the browser will block regardless).
 *
 * Mirrors the behavior of @fastify/cors with `credentials: true` so
 * that hijacked SSE responses look byte-identical to non-hijacked ones.
 */
export function buildCorsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin) return {};
    const allow = new Set(getCorsAllowOrigins());
    if (!allow.has(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
    };
}
