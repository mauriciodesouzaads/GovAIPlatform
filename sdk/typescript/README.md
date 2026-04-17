# @govai/sdk

Official TypeScript client for the **GovAI Platform API** — the enterprise
AI governance gateway. Types are generated from the versioned OpenAPI
spec shipped in the platform repo (`docs/api/openapi.yaml`), so every
route and response body is fully typed.

## Install

```bash
npm install @govai/sdk
```

The only runtime dependency is `openapi-fetch` (a ~2 kB wrapper over the
native `fetch`). Works in Node 20+, Bun, Deno, and modern browsers.

## Quick start

```ts
import { createGovAIClient } from '@govai/sdk';

const client = createGovAIClient({
    baseUrl: 'https://api.yourcompany.com',
    apiKey: process.env.GOVAI_API_KEY!,
    orgId: process.env.GOVAI_ORG_ID!,
});

const { data, error } = await client.GET('/v1/admin/assistants');
if (error) throw error;
for (const a of data) {
    console.log(a.id, a.name);
}
```

All paths / params / responses are typed — your editor will autocomplete
every available route and reject invalid param names at compile time.

## Execute an assistant

```ts
const { data, error } = await client.POST('/v1/execute/{assistantId}', {
    params: { path: { assistantId: '00000000-0000-0000-0002-000000000001' } },
    body: { message: 'Summarize quarterly risk findings.' },
});
```

## Stream chat (SSE)

`openapi-fetch` returns a raw `Response` for streaming endpoints; pipe
it through the standard Web Streams API:

```ts
const res = await client.POST('/v1/admin/chat/send/stream', {
    body: { assistant_id: ASSISTANT_ID, message: 'Hello' },
    parseAs: 'stream',
});
if (!res.response.ok || !res.response.body) throw res.error;

const reader = res.response.body.getReader();
const decoder = new TextDecoder();
while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value));
}
```

## Rate limits

The client honors the `X-RateLimit-*` and `Retry-After` headers emitted
by the platform (see `docs/api/RATE_LIMITS.md`). When the remaining
quota drops below 5 % of the bucket the next call is throttled; on a
429 the client backs off for `Retry-After` seconds (capped at 60 s).

Disable if you want to implement your own backoff:

```ts
const client = createGovAIClient({ baseUrl, apiKey, autoBackoff: false });
```

## Per-request headers

```ts
await client.GET('/v1/admin/stats', {
    headers: { 'x-trace-id': 'custom-trace-1234' },
});
```

## Regenerate types when the API changes

```bash
cd sdk/typescript
npm run generate:types   # reads ../../docs/api/openapi.yaml
```

The CI drift guard (`npm run openapi:check` in the platform repo)
ensures the spec file stays in sync with the live routes.

## License

Apache-2.0. See `LICENSE` at the repo root.
