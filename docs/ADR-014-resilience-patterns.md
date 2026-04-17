# ADR-014: Resilience Patterns

## Status: Accepted

## Context

Single-instance deployments work. Production under sustained load needs
explicit protection against five failure modes observed (or likely to be
observed) in the pre-FASE-11 system:

1. **Stuck work items** — if a worker crashes mid-dispatch, the item stays
   in `in_progress` forever because the 1-hour BullMQ `lockDuration` is
   longer than any observation window. Real example from the Fase 11 diag
   run: one work item was stuck for 3h33min with `worker_runtime=openclaude`
   and no events.
2. **Runner instability cascading** — if the runtime is degraded (timeouts,
   network flakiness), the GovAI backend keeps forwarding requests and
   every user sees failures until a human intervenes.
3. **Tenant noisy-neighbor** — global concurrency=2 in the architect worker
   means a single chatty org can monopolize both slots and starve every
   other tenant.
4. **Disk fill-up** — long-running processes that never clean up workspace
   dirs eventually run out of disk on the shared volume.
5. **Unrecoverable DB loss** — backup existed but was never validated;
   "untested" = "doesn't work" until proven otherwise.

## Decision

### Stuck work item watchdog

- New function `detectAndMarkStuckWorkItems(pool)` in `architect-delegation.ts`
- Called every 5 minutes by the architect worker
- Marks any `in_progress` or `awaiting_approval` item idle for >15 minutes
  as `blocked` with `dispatch_error = "Stuck for N minutes — watchdog
  marked blocked"`
- Threshold configurable via `ARCHITECT_STUCK_THRESHOLD_MIN`
- Operators see the reason in the existing dispatch_error UI field and can
  retry manually

### Circuit breaker per runtime

- `src/lib/circuit-breaker.ts` — closed/open/half_open state machine
- Opens after `CIRCUIT_FAILURE_THRESHOLD=5` consecutive failures
- Stays open for `CIRCUIT_OPEN_DURATION_MS=30000` (30s)
- After cool-down, allows one probe; 2 successes → closed, failure → open
- Work items rejected by the breaker get `status=blocked` with clear
  "Circuit breaker open" message — not silent fallback
- One breaker per `runtime:<slug>` key

### Per-tenant concurrency

- `src/lib/tenant-concurrency.ts` — Redis atomic INCR/DECR with 15 min
  safety TTL
- Default `TENANT_MAX_CONCURRENT=1` — a single tenant can't monopolize
  both slots of the global architect worker
- Fails OPEN when Redis is degraded (one limiter can't block every tenant)
- BullMQ re-queues rejected jobs; scheduler gives other tenants a shot

### Workspace TTL + periodic cleanup

- Existing `cleanupOrphanedWorkspaces()` already deletes dirs older than
  `GOVAI_WORKSPACE_MAX_AGE_HOURS` (default 24h)
- FASE 11 adds: called every 30 min by the architect worker (not just
  on-boot) so long-running processes don't leak disk
- FASE 11 adds: SIGTERM/SIGINT handlers run a final cleanup + `worker.close()`

### Backup automation + validation

- `scripts/backup-db.sh` — enhanced with file-size validation, human-
  readable retention logs, and an audit_logs entry per run
- `scripts/test-restore.sh` — NEW. Creates a throwaway DB, restores the
  latest backup, counts tables (≥50 expected), drops the DB
- Documented RPO (24h with daily cron) and RTO (<15min) in OPERATIONS.md

### LLM multi-provider: LiteLLM primary, OpenRouter opt-in

- **LiteLLM stays the gateway.** Self-hosted, zero markup, no
  third-party-SaaS transit of regulated data — essential for LGPD Art. 46
  and BACEN 4.658 compliance in banking/government workloads.
- **OpenRouter added as opt-in backend.** `OPENROUTER_API_KEY` unset by
  default disables the feature. When enabled, `govai-llm-openrouter` and
  `govai-llm-openrouter-llama` aliases route through OpenRouter's edge.
- **Use case separation:** OpenRouter for model experimentation /
  niche-model access; direct providers (Groq, Cerebras, Gemini) for
  production regulated traffic (lower latency, zero markup, data
  sovereignty).

### Claude Code SDK — health probe mode

- `claude-code-runner/bridge.js` now recognizes the sentinel message
  `__govai_probe__` and responds with a synthetic done event — no CLI
  spawn, no API call, no cost.
- Future health-check endpoints can validate the sidecar is reachable
  and parsing proto correctly without spending Anthropic credits.

## Trade-offs

- **Watchdog false positives** — a legitimately slow LLM turn (>15 min)
  gets flagged as stuck. Mitigation: operators see "watchdog marked
  blocked" in dispatch_error and can raise `ARCHITECT_STUCK_THRESHOLD_MIN`
  per deployment.
- **Circuit breaker + user confusion** — first few users see clear error,
  next 30s of users see "Circuit open" without understanding the root
  cause. Mitigation: add observability alert (FASE 10) so ops team knows
  before end-users complain.
- **Per-tenant limiter + high-traffic orgs** — default 1 means even a
  big customer waits in queue if two concurrent chats come in. Mitigation:
  `TENANT_MAX_CONCURRENT` per-deployment env; enterprise customers can
  request a higher limit.
- **Fail-open on Redis** — if Redis goes down, concurrency and health
  caches all fail open. This is intentional: availability > strict limits
  for a degraded Redis scenario, since Redis is itself a single point of
  failure that would cascade otherwise.

## Alternatives considered

- **Sticky session routing** — would require ALB/ingress config and
  wouldn't help the BullMQ worker path. Rejected.
- **External Temporal/Inngest** — introduces a new hard dependency and
  changes the operational model. Over-engineered for our needs.
- **pg_dump + S3 push** instead of local retention — plan for v2. Today's
  script outputs to `./backups` by default; customers can post-process
  with their own S3/GCS sync.

## Consequences

- Operators now have real visibility into stuck work items (dispatch_error
  field + watchdog log lines)
- Runtime outages auto-recover after 30s instead of requiring human
  intervention
- Backup/restore is CI-testable — no "unknown if works" state
- Feature flags (`TENANT_MAX_CONCURRENT`, `CIRCUIT_FAILURE_THRESHOLD`,
  etc.) let operators tune per-deployment without code changes
