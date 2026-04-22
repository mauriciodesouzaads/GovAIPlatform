# Diagnostic — Runtime Hang — 2026-04-22

## HEAD
```
efcecb1 feat(shield): 3-level governance model — FASE 13.5a
```
Working tree: clean.

## Container States

| Service | Status | Uptime | Note |
|---|---|---|---|
| api | Up (healthy) | ~2h | restarted for 13.5a rebuild |
| admin-ui | Up (healthy) | ~1h | |
| database | Up (healthy) | 4 days | |
| litellm | Up (healthy) | 4 days | |
| openclaude-runner | Up (healthy) | 4 days | boot logs only, NO request activity |
| presidio | Up (healthy) | 4 days | |
| redis | Up (healthy) | 4 days | |
| **claude-code-runner** | **NOT RUNNING** | — | profile `official` never started |

## LiteLLM

### /health summary (with auth)

```
healthy: 6       unhealthy: 6

healthy:
  groq/llama-3.1-8b-instant           ← default route for govai-llm
  groq/llama-3.1-8b-instant           (duplicated — fallback)
  groq/llama-3.3-70b-versatile
  cerebras/qwen-3-235b-a22b-instruct-2507
  cerebras/llama3.1-8b
  anthropic/claude-sonnet-4-20250514

unhealthy:
  gemini/gemini-2.5-flash-lite        429  Gemini free-tier quota exhausted (20/day)
  gemini/gemini-2.5-flash             429  Gemini free-tier quota exhausted (20/day)
  ollama_chat/qwen2.5:3b              Connection refused host.docker.internal:11434
  openai/gpt-4o                       401  OPENAI_API_KEY not set
  openrouter/anthropic/claude-3.5...  401  No cookie auth credentials found
  openrouter/meta-llama/llama-3.3...  401  No cookie auth credentials found
```

### Direct pings

```
govai-llm        (Groq llama-3.1-8b-instant)  → 200 "ok"  (immediate)
govai-llm-gemini (Gemini flash-lite)          → timeout >10s  (internal retry on 429)
```

### Log pattern
Every ~5s the `api` container (IP 172.18.0.6) hits `GET /health` without a bearer → 401 loop. Cosmetic, does not affect traffic. Pre-existing across all FASE 13.x runs.

## OpenClaude Runner

### Full recent log (100 lines)
```
Starting OpenClaude gRPC Server...
[GovAI Locked Mode] Skipping provider profile, credentials hydration, and validation
[GovAI Locked Mode] OPENAI_BASE_URL = http://litellm:4000/v1
[GovAI Locked Mode] OPENAI_MODEL    = govai-llm-gemini      ← pinned to the UNHEALTHY model
gRPC Server running at unix:/var/run/govai/openclaude.sock
gRPC Server running at 0.0.0.0:50051
```

**Zero request activity.** Four days of uptime, only boot messages. Not a single "session start" or "adapter connect" log line. No request ever reached the runner.

### TCP reachability from api
```
TCP_OK   (port 50051 open, unix socket /var/run/govai/openclaude.sock present with srw-rw-rw-)
```

The runner IS reachable. The adapter simply never opens a connection because dispatch rejects before reaching the adapter call.

## API Logs — dispatch chatter (last 500 lines)

Key pattern, observed repeatedly for each hung work item:

```
[Architect Worker] Dispatching work item 3cfab8af-157d-4c8f-830c-df9df8dd4e9f for org 00000000-...
[Architect Worker] tenant 00000000-... at concurrency limit, re-queuing
[Architect Worker] Job 7 (dispatch-openclaude) failed: TENANT_LIMIT
[Architect Worker] Dispatching work item 3cfab8af-...           ← BullMQ retry 2
[Architect Worker] tenant 00000000-... at concurrency limit, re-queuing
[Architect Worker] Job 7 (dispatch-openclaude) failed: TENANT_LIMIT
[Architect Worker] Dispatching work item 3cfab8af-...           ← BullMQ retry 3
[Architect Worker] tenant 00000000-... at concurrency limit, re-queuing
[Architect Worker] Job 7 (dispatch-openclaude) failed: TENANT_LIMIT
(no more dispatches for this id — BullMQ moved job to failed queue)
```

Same pattern for every PENDING work item (`3cfab8af`, `0089d9e9`, `ef6cd41a`).

## Work Items (last 2h)

| id_short | status   | dispatch_attempts | err    | age_s | idle_s | paired-with |
|----------|----------|-------------------|--------|-------|--------|-------------|
| 0089d9e9 | **pending** | 0 | (none) | 1595 | 1595 | 6816a464 (done) |
| 6816a464 | done     | 1 | (none) | 1595 | 1293 | — |
| 3cfab8af | **pending** | 0 | (none) | 3075 | 3075 | 788278e6 (done) |
| 788278e6 | done     | 1 | (none) | 3075 | 2775 | — |
| ef6cd41a | **pending** | 0 | (none) | 3897 | 3897 | d378e8dd (done) |
| d378e8dd | done     | 1 | (none) | 4040 | 3607 | — |
| 6942f87f | done     | 1 | (none) | 5086 | 4814 | — |
| 62b97f60 | done     | 1 | (none) | 5095 | 5086 | — |

Pattern: **every PENDING work item was created within ~10s of a "done" work item that was already occupying the tenant slot**.

## Work Item Events (3 stuck items)

```
wi       | wi_status | event_type   | created_at
---------+-----------+--------------+-----------
0089d9e9 | pending   | (no events)  | (no events)
3cfab8af | pending   | (no events)  | (no events)
ef6cd41a | pending   | (no events)  | (no events)
```

**Zero events** for each. The adapter never executed for these — rejection happened at the tenant-concurrency gate before any event could be emitted.

## BullMQ Queue State (architect-dispatch)
```
wait       = 0
active     = 0
delayed    = 0
failed     = WRONGTYPE (hash, not list — queue keeps failed metadata elsewhere)
completed  = WRONGTYPE (same)
```

Queue is **empty now**. The stuck jobs already exhausted retries and were dropped from the queue.

## Circuit Breaker & Tenant Concurrency
```
# circuit breaker messages in last 500 lines
(none)

# tenant concurrency counters in Redis
govai:architect:concurrency:*   → EMPTY
```

No Redis key exists now. The `LEASE_TTL_SEC=900` on the counter (`src/lib/tenant-concurrency.ts:22`) already expired. The successful `6816a464` / `788278e6` / `d378e8dd` runs properly called `releaseTenantSlot()` when they finished — but by then, their paired PENDING item had already exhausted its retries and left the queue.

## Claude Code Official Runner
```
ANTHROPIC_API_KEY no .env:              SET
Container sob profile official:         DOWN (profile never brought up)
```

The UI shows "Claude Code Official: Indisponível" because the container isn't running. The key is present; the profile just needs `docker compose --profile official up -d claude-code-runner`.

---

## Hipótese de causa raiz — CONFIRMADA

**H5 + H2 (combinado) — BullMQ retry budget stacks on TENANT_LIMIT, work items get orphaned in PENDING.**

### Sequência exata (reproduzível)

1. User sends message → executeAssistant → creates work item A + enqueues dispatch job
2. Worker acquires tenant slot (counter 0→1), starts running item A (slow, ~30-60s with Gemini 429 retries)
3. User sends **second** message before A finishes → item B created + enqueued
4. Worker pulls B's dispatch job. Calls `acquireTenantSlot(orgId)`:
   - counter 1→2, but `TENANT_MAX_CONCURRENT=1` (default)
   - decrements back to 1
   - returns `false`
5. Worker throws `TENANT_LIMIT` → BullMQ treats as job failure
6. BullMQ retries (attempts=3, exponential backoff 5s/10s/20s) — all still while A runs
7. After 3 failed attempts B's job is moved to `failed` queue and **dropped**
8. Item A finishes, `releaseTenantSlot()` drops counter to 0 → but B's job is GONE
9. Item B remains `status='pending'` in DB **forever**. The user sees "Aguardando dispatch…" indefinitely.

### Why the automated test (E2E 9/9) doesn't hit this

`test-openclaude-e2e.sh` submits **one** work item and polls until done. Single-item workload, no paired dispatch, `TENANT_MAX_CONCURRENT=1` never bites. This is why CI goes green while the live UX breaks the moment a user sends two messages back-to-back.

### Why the hung items show `dispatch_attempts=0`

`dispatch_attempts` is incremented inside `dispatchWorkItem()` (the adapter entry). TENANT_LIMIT rejects BEFORE that counter is touched. So the DB reflects 0 attempts even though BullMQ retried 3 times — consistent.

### Secondary exacerbating factor (makes the bug more visible today)

`govai-llm-gemini` is in 429 Gemini free-tier quota. The openclaude-runner, hardcoded to `OPENAI_MODEL=govai-llm-gemini`, retries internally when calling the unhealthy route. This **stretches slot hold time from ~10s to 60-180s**, making it likely the user submits a second message while the first still holds the slot.

If the runner were configured to prefer `govai-llm` (Groq) — which is healthy and fast — the hold-time window would shrink dramatically and the TENANT_LIMIT hazard would be rare, even without the underlying retry-budget fix.

### Why `/health` in the UI reports `litellm: disconnected`

Pre-existing cosmetic bug. The api healthcheck polls LiteLLM's `/health` WITHOUT the bearer token, gets 401, reports `disconnected`. But LiteLLM is actually up and serving real chat requests fine (see `govai-llm` 200 "ok" above). NOT related to the work-item hang.

---

## Signals prioritized (por ordem do prompt)

1. **Events do work_item** — **ZERO** para os 3 PENDING. Rejeição antes do adapter. ✅ sinal claro
2. **Tenant concurrency counter** — agora vazio (TTL expirou), mas os logs mostram que **esteve em 1 quando cada PENDING foi rejeitado**. Slot NÃO vazou; foi released corretamente. O problema é o budget de retry BullMQ, não slot leak. ✅ corrige H2 inicial
3. **LiteLLM /health + ping** — `disconnected` no healthcheck é falso-positivo por falta de auth; `govai-llm` funciona, `govai-llm-gemini` está em 429 Gemini free tier (quota diária exaurida). Exacerba (não causa) o problema.
4. **ANTHROPIC_API_KEY** — SET no .env; `claude-code-runner` container simplesmente não foi subido com `--profile official`. Explica a "Indisponível" no UI mas é ortogonal ao bug do OpenClaude hang.

---

## Recomendação (não implementar — próximo prompt)

Três mudanças pequenas, todas independentes:

### Fix A (primary) — resolver TENANT_LIMIT sem explodir job
Em `src/workers/architect.worker.ts` (linha ~283), em vez de `throw new Error('TENANT_LIMIT')`, re-inserir o job com `delayed` maior:

```ts
if (!(await acquireTenantSlot(orgId))) {
    // Re-queue with a 30s delay without consuming retry budget
    await architectQueue.add(job.name, job.data, { delay: 30_000, attempts: 1 });
    return;  // graceful completion, BullMQ doesn't increment attempt
}
```

Ou, alternativamente, set `attempts: 20` para `TENANT_LIMIT` especificamente, deixando o exponential backoff cobrir 20 × 5s = mais de 20min de espera.

### Fix B (secondary) — resgatar PENDING órfãos
Watchdog (já existe — "Architect Worker watchdog=5min") deveria re-enfileirar itens com `status='pending' AND created_at < NOW() - interval '5 minutes' AND dispatch_attempts=0`. Verificar se já faz (checando `detectAndMarkStuckWorkItems` ou similar).

### Fix C (tertiary) — resiliência do runtime contra provider quota
Trocar `OPENAI_MODEL=govai-llm-gemini` por `OPENAI_MODEL=govai-llm` no `docker-compose.yml` para o `openclaude-runner`. `govai-llm` aponta para Groq llama-3.1-8b-instant que está healthy e tem quota ampla. Gemini free tier é ruim para load interativa.

**Não relacionado ao bug principal, mas ortogonal:**

- Subir `claude-code-runner` via `--profile official up -d` para o selector da UI parar de mostrar "Indisponível"
- Passar `Authorization` no healthcheck do api para LiteLLM parar de reportar `disconnected` no `/health`

---

## Resumo executivo (1 frase)

**Work items ficam presos em PENDING quando o usuário submete 2 prompts em sequência porque o segundo é rejeitado por `TENANT_LIMIT` e o BullMQ esgota 3 tentativas em ~35s enquanto o primeiro ainda está rodando (especialmente lento hoje devido ao rate limit do Gemini free tier); o item órfão nunca é re-dispatched.**

---

## Resolution — FASE 13.5a1

Applied five independent fixes in a single commit:

### Fix A (primary) — `src/workers/architect.worker.ts`
`TENANT_LIMIT` no longer throws. The worker now calls a new helper
`handleTenantLimitRejection(pool, queue, args)` that re-enqueues the
dispatch as a fresh job with `attempts: 1` and a 30 s delay
(`TENANT_LIMIT_REQUEUE_DELAY_SEC`). After
`TENANT_LIMIT_MAX_REQUEUES` (default 40, ~20 min window) it marks the
work_item `status='blocked'` with
`dispatch_error='tenant_limit_exhausted after N requeues (~Mmin)'`.
**This alone resolves the reported bug.**

### Fix B (watchdog) — migration 085 + `recoverOrphanedPendingWorkItems`
New column `architect_work_items.recovery_attempts SMALLINT DEFAULT 0`
and a partial index
`idx_architect_work_items_orphan_sweep ON (created_at) WHERE status='pending' AND dispatch_attempts=0`.
The architect worker's watchdog loop (every 5 min) now sweeps this
set, cross-checks BullMQ `wait/active/delayed` queues, and
re-dispatches any item with no live job. After 3 failed recoveries,
the item is marked `blocked` with
`dispatch_error='watchdog_recovery_exhausted'`. Defensive — Fix A
should prevent orphans from forming in the first place.

### Fix C (resilience) — `docker-compose.yml` + `.env.example`
`openclaude-runner` default `OPENAI_MODEL` changed from
`govai-llm-gemini` (free tier 20 req/day, currently 429) to
`govai-llm-cerebras` (Cerebras qwen-3-235b, healthy, high TPM).
Override via `OPENCLAUDE_DEFAULT_MODEL` env var. `govai-llm` (Groq)
was rejected because its 6 K TPM is too tight for OpenClaude's
~18 K token/turn system prompt — documented inline.

### Fix D (dev ergonomics) — `scripts/dev-up-full.sh` + `README.md`
New convenience script starts dev + official profiles together so
the Claude Code Official runtime appears in the UI selector when
`ANTHROPIC_API_KEY` is configured. README now points operators at it.

### Fix E (cosmetic) — `src/server.ts` `/health`
Switched the LiteLLM probe from authenticated `/health` (which returned
401 in the api container's heartbeat loop) to the public
`/health/liveliness` endpoint. Also sends `Authorization: Bearer
$LITELLM_KEY` when available, so future auth-required endpoints work
too. `/health.litellm` no longer falsely reports `disconnected`.

### Acceptance — `tests/integration/test-concurrent-delegation.sh`
Submits two `[OPENCLAUDE]` work items 2 s apart. Before the fix, the
second stayed PENDING forever. After the fix:

```
poll 1/160:  A=in_progress  B=pending
poll 2/160:  A=done         B=pending
...
poll 10/160: A=done         B=done         ← B waited 30 s for the slot, then ran
```

### Unit tests
`src/__tests__/architect-worker-tenant-limit.test.ts` — 7 assertions
covering the matrix: re-enqueue with default delay, counter
increment, `TENANT_LIMIT_MAX_REQUEUES` cutoff → blocked,
`TENANT_LIMIT_REQUEUE_DELAY_SEC` override, orphan recovery by the
watchdog, live-job deduplication, exhausted-budget blocking.
