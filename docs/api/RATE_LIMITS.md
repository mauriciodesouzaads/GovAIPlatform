# Rate Limits — GovAI Platform API

The platform enforces rate limits to protect the backend and the
managed LLM providers. Limits are applied per credential (Bearer
token / API key) or, for unauthenticated requests, per source IP.

## Global policy

| Caller | Requests per minute | Notes |
|---|---|---|
| Authenticated (API key or JWT) | **1 000** | Burst tolerant; enforced rolling 60 s window |
| Unauthenticated (login, health, public docs) | **50** | Per source IP |

Limits are implemented with [`@fastify/rate-limit`](https://github.com/fastify/fastify-rate-limit)
backed by Redis (so they're enforced consistently across multiple API
instances).

## Response headers

Every response (success or 429) carries the canonical triad:

```
X-RateLimit-Limit:     1000          # bucket size for this caller
X-RateLimit-Remaining: 987           # requests left in the current window
X-RateLimit-Reset:     1713357600    # unix timestamp when the window resets
```

On a 429, an extra header tells the client how long to back off:

```
Retry-After: 42                      # seconds
```

## 429 response body

```json
{
    "statusCode": 429,
    "error": "Rate limit exceeded",
    "message": "Limite de requisições excedido.",
    "retryAfter": 42
}
```

## SDK behavior

The official SDKs (`@govai/sdk` for TypeScript, `govai-sdk` for
Python) read `X-RateLimit-Remaining` and, when below 5 % of the
bucket, apply proactive jittered backoff before the next call.
On a 429 they honor `Retry-After` with exponential backoff capped at
60 s. You can disable this behavior by setting `autoBackoff: false`
on the client options.

## Route-level considerations

A few routes are more expensive than the global budget assumes and
will reject earlier if the backend cannot keep up:

- `POST /v1/admin/chat/send` and `POST /v1/admin/chat/send/stream` —
  bounded by the LLM provider's own limits (Groq, Cerebras, Gemini,
  etc.). A 429 here reflects the upstream, not our rate limiter; the
  `Retry-After` is the provider's.
- `POST /v1/execute/{assistantId}` — same provider pressure plus the
  per-org FinOps hard cap. When the org is over its monthly budget
  we return `402 Payment Required` with `X-GovAI-Finops: hard-cap`,
  NOT a 429.
- `GET /v1/admin/compliance/audit-trail` — heavy CSV export; we
  serialize one request at a time per org via a Redis advisory lock
  (no rate-limit change, but a second concurrent call waits).

## Raising your limits

Enterprise customers can request higher buckets. The call is
org-scoped (not per-user) and applied by the platform-admin role.
Currently this is a platform-side configuration — there is no self-
service UI; contact support with the expected sustained RPS and a
short description of the workload.

## Observability

- **Metric:** `govai_rate_limit_rejections_total{org_id, route}` —
  Prometheus counter.
- **Log field:** `event: "rate_limit_exceeded"` in Loki with the
  caller + route + TTL.
- **SIEM:** 429s emit a `RATE_LIMIT_EXCEEDED` event to every
  configured SIEM channel (see FASE 12 SIEM integration).
