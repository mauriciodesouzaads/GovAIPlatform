# ADR-022: CORS headers replicated on hijacked SSE responses

## Status: Accepted — FASE 13.5a2

## Context

`@fastify/cors` injects `Access-Control-Allow-*` headers via the
`onSend` hook. `reply.hijack()` removes the reply from Fastify's
pipeline, so `onSend` never fires, and hijacked responses go out
WITHOUT CORS headers — browsers silently reject them with
`TypeError: Failed to fetch`.

curl and server-side integration tests do not exercise CORS, so this
bug escaped 45/45 API tests, 9/9 E2E, and the full CI pipeline. It was
only surfaced by opening the browser against the Chat Governado page
(`admin-ui:3001` → `api:3000`). Investigation trail lives in
`docs/STREAM_HANDLER_INVESTIGATION_20260422_2113.md`.

## Decision

1. Define a single allow-list in `src/lib/cors-config.ts`:
   - `getCorsAllowOrigins(): string[]`
   - `buildCorsHeaders(origin): Record<string, string>`
2. `server.ts` consumes `getCorsAllowOrigins()` when registering the
   cors plugin.
3. Any route that calls `reply.hijack()` MUST call
   `buildCorsHeaders(request.headers.origin)` and spread the returned
   headers into its `reply.raw.writeHead(...)` call.
4. New integration test
   (`tests/integration/test-chat-stream-cors.sh`) exercises headers
   directly — running in the regression pipeline, this regression
   cannot silently reappear.

## Alternatives considered

- **Use `@fastify/sse` plugin** — mid-size refactor of the existing
  `reply.raw.write(...)` loop, larger blast radius. Rejected for this
  fix; may be revisited if we add more SSE routes.
- **Stop hijacking and stream via `reply.send()` with a Node stream** —
  requires re-threading the chunking loop and the `sendFrame`
  abstraction. Same rejection rationale.
- **Compute ACAO in an `onRequest` hook and push into request
  context** — less explicit, harder to unit-test the output shape.
  Also doesn't solve the problem: the hijacked write path still needs
  to know which headers to include.

## Consequences

- New routes that use `reply.hijack()` must remember to call
  `buildCorsHeaders()`. Documented at both call sites and in this ADR.
  The code comment above the `writeHead` call explicitly references
  this ADR number to help the next engineer.
- If a 4th allow-list entry needs to be added later, edit only
  `cors-config.ts`; the plugin register and the hijack site pick it
  up. Zero drift.
- The integration test is now a hard barrier against the regression —
  a 4th case explicitly verifies that a non-allowed origin does NOT
  get echoed (security invariant).
- No behavior change for any other route. `/chat/send` (JSON, no
  hijack) still flows through the standard Fastify pipeline with the
  plugin handling CORS on its own.

## Failure mode the fix locks down

> Browser cross-origin `fetch` to a hijacked SSE endpoint returns
> `TypeError: Failed to fetch` because the response is missing
> `Access-Control-Allow-Origin`. Works in curl (no CORS), breaks in
> Chrome/Safari/Firefox.

## Follow-ups (out of scope for 13.5a2)

- Consider a lint rule / custom ESLint check: "routes that call
  `reply.hijack()` must also call `buildCorsHeaders()`." Low effort if
  it becomes relevant (we have a single hijacked route today).
- If we move to `@fastify/sse` at some point, this ADR can be marked
  Superseded — the plugin handles CORS naturally because it doesn't
  hijack.
