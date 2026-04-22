# ADR-021: Tenant-limit rejection uses re-enqueue, not throw

## Status: Accepted

## Context

FASE 11 introduced a per-tenant concurrency gate
(`src/lib/tenant-concurrency.ts`) on the architect dispatch worker to
prevent a single org from starving the global 2-slot worker pool.
`TENANT_MAX_CONCURRENT` defaults to **1**: one dispatch in flight per
org at a time.

The original implementation threw `new Error('TENANT_LIMIT')` when the
slot was busy, and relied on BullMQ's retry mechanism to re-queue the
job:

```ts
if (!(await acquireTenantSlot(orgId))) {
    throw new Error('TENANT_LIMIT');   // ← queue config: attempts=3,
                                       //   backoff exponential 5s
}
```

### Why this was silently broken

BullMQ retries the failed job with `attempts: 3`, exponential backoff
base `5_000`. The three retries land at roughly `t=0s, t=5s, t=15s,
t=35s` — the job is dropped at `t=35s`.

The first dispatch, however, typically holds the slot for **60–180 s**
(LLM call + tool rounds). With `govai-llm-gemini` in the configured
route and Google's free-tier throttling recently, 150+ seconds was
common. So the second dispatch always burned its retry budget in the
first 35 s — well before the first slot released — and BullMQ dropped
the job permanently. The row in `architect_work_items` stayed at
`status='pending' AND dispatch_attempts=0` **forever**, manifesting
as "Aguardando dispatch…" indefinitely on the UI.

Unit + E2E tests did not catch this: the single-item
`test-openclaude-e2e.sh` never generates contention. The bug only
appears when two items race for the same tenant slot, which is the
baseline live-UX workflow ("ask, ask again") the moment a real user
touches the product.

Diagnostic writeup lives at `docs/DIAGNOSTIC_RUNTIME_HANG_20260422.md`.

## Decision

Replace the `throw` with a **re-enqueue** as a brand-new job with
`attempts: 1`, `delay: TENANT_LIMIT_REQUEUE_DELAY_SEC * 1000` (default
30 s). A monotonic `_tenantLimitRequeues` counter travels in the job
payload; after `TENANT_LIMIT_MAX_REQUEUES` (default 40) attempts the
work_item is marked `status='blocked'` with a human-readable
`dispatch_error`.

The extracted helper `handleTenantLimitRejection(pool, queue, args)`
owns both behaviors and is the single call site from the worker
processor.

### Why re-enqueue with fresh budget, not longer `attempts`

Three options considered:

1. **Keep `throw` + raise `attempts` to 20.** Rejected. Still
   conflates "the slot is busy" with "the job itself failed" in
   BullMQ's failure metrics. The failure counter would now register
   19 spurious failures for every `TENANT_LIMIT`, polluting
   Prometheus `architect_dispatch_failures_total` forever.
2. **Re-enqueue as a fresh job with `attempts: 1`.** Accepted. Each
   re-enqueue is a clean new job. BullMQ never records a failure.
   The `_tenantLimitRequeues` counter inside the payload gives us
   cheap observability and a principled cap.
3. **Separate queue for tenant-deferred jobs.** Rejected. Another
   queue means another worker, another lock, another failure mode.
   Same outcome achievable with the counter.

### Why `delay: 30 s` and `maxRequeues: 40`

- 30 s is larger than the tail-latency of a typical dispatch (~15 s
  p99 once Cerebras is the runtime default) but small enough that a
  user doesn't notice the second message lagging. Measured: second
  item completed at poll 10 (= ~30 s) in
  `test-concurrent-delegation.sh`, which is exactly one cycle.
- 40 × 30 s = 20 minutes of patience before we call the item blocked.
  Covers a worst-case run of ~15 min (e.g., tool-intensive agent with
  approvals) plus slack for requeue timing. An org that legitimately
  needs more than 20 min for a single agent run is abnormal and
  probably has a stuck adapter that the stuck-worker sweep
  (`detectAndMarkStuckWorkItems`) will catch separately.

Both values are env-tunable.

### Why a watchdog layer on top (Fix B)

Even with Fix A, a crash mid-rejection (e.g., Redis blip between
`acquireTenantSlot` returning false and the re-enqueue) could leave
the item orphaned. The watchdog in the same worker — which already
runs every 5 min for the stuck-run sweep — now also scans for
`status='pending' AND dispatch_attempts=0` rows older than 5 min with
no live BullMQ job, and re-enqueues them with `jobId` suffixed
`-recovery-N`. Defensive; in steady-state, it should report zero
recoveries.

## Trade-offs

- **Re-enqueued jobs consume Redis storage.** Each new job = a new
  key, bounded by `removeOnFail` to 100 old rows and 3600 s age.
  Worst-case storage: 40 requeues × 1 org × ~500 bytes ≈ 20 KB per
  blocked item. Negligible.
- **`_tenantLimitRequeues` leaks the mechanism into the job payload.**
  Marked with a leading underscore and documented in the interface.
  External callers should never set it.
- **Change of model default (Fix C) in the same commit.** The
  `govai-llm-gemini` → `govai-llm-cerebras` switch is strictly
  orthogonal to Fix A but compounds to reduce hold-time by ~10× in
  practice. Bundled so that operators who pull 13.5a1 see both
  improvements together rather than shipping the fix against a
  still-degraded provider.
- **`maxRequeues=40` is arbitrary.** Tuning happens per-deployment
  via env var. If we ever see real customers hitting the ceiling,
  we'll raise it and export a Prometheus gauge for
  `architect_tenant_limit_requeues`.

## Alternatives considered

- **Lower `TENANT_MAX_CONCURRENT=2`.** Rejected: that changes the
  isolation contract. Today an org provably cannot burn more than
  1 worker slot. Going to 2 halves the noisy-neighbor protection.
  The bug is in the rejection handling, not in the limit itself.
- **Remove the tenant gate entirely.** Rejected for the same
  reason — the gate is legitimate defense against abuse and
  accidental loops. Strengthening the rejection path is the right
  surgery.
- **Use BullMQ's `Flow` / `Parent-Child` jobs to serialize per
  tenant.** Considered. Heavier than the counter approach and
  requires restructuring every call site. The current design is a
  12-line helper — proportional to the problem.
- **Custom Redis Lua limiter (fair-scheduler).** Over-engineered.
  Start simple; upgrade when observability shows it's needed.

## Consequences

- `Aguardando dispatch…` no longer spins forever after the second
  rapid-fire message. Confirmed by `test-concurrent-delegation.sh`.
- Fewer spurious BullMQ `failed` events → cleaner audit / metrics.
- New knobs: `TENANT_LIMIT_REQUEUE_DELAY_SEC`,
  `TENANT_LIMIT_MAX_REQUEUES`, `ARCHITECT_ORPHAN_THRESHOLD_MIN`,
  `ARCHITECT_MAX_RECOVERY_ATTEMPTS`. Documented in `.env.example`.
- Follow-ups (Fase 14): export requeue / recovery counts as
  Prometheus gauges; add a grafana panel for the tenant-limit
  pressure over time.
