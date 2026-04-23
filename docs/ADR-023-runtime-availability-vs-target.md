# ADR-023: Runtime availability check must match runtime target resolution

## Status: Accepted — FASE 13.5a3

## Context

Two functions in `src/lib/runtime-profiles.ts` had subtly different
logic:

- **`resolveRuntimeTarget(profile)`** — used by the adapter at call
  time. Tries unix socket first, falls back to TCP host, final fallback
  to `container_service:50051`. Never returns "unavailable" — always
  returns *some* target and lets the adapter surface real connection
  errors.

- **`isRuntimeAvailable(profile)`** — used by the UI (via
  `/v1/admin/runtimes` and its cached wrapper) to drive the
  "Disponível / Indisponível" badge in the Chat Governado runtime
  selector. Before this fix, it returned `false` immediately if the
  configured socket path didn't exist — even when TCP host was
  configured and the sidecar was reachable.

This mismatch caused `claude-code-runner` to appear as "Indisponível"
in the UI even while the container was `Up (healthy)` and actually
responding on `0.0.0.0:50051`. In our dev environment the root
issue was a unix-socket bind failure (`EACCES` on a shared volume
with uid conflict between the two runners) — cosmetic at the
transport layer (the adapter always fell back to TCP cleanly), but
fatal for the UI's upfront availability check.

Browser testing confirmed the adapter still worked end-to-end:
delegated work items reached `done`, tools executed (Write + Bash
both observed with real permission strings in the output). It was
purely the UI refusing to offer the runtime.

## Decision

`isRuntimeAvailable` now mirrors `resolveRuntimeTarget` semantics:

1. Try the unix socket. If `fs.accessSync` succeeds, return `true`.
2. If the socket check fails, **do not return false immediately**.
   Fall through to the TCP host check.
3. If the TCP host env var is set, return `true` and let the adapter
   report real connection errors at call time.
4. Only return `false` when neither transport is configured.

A new helper `invalidateRuntimeHealthCache(slug?)` drops the Redis
cache (`runtime:health:*`) so the new rule takes effect immediately
after an api boot — without this, the 30 s TTL could keep a stale
"false" verdict around. It's called from `src/server.ts` right after
`fastify.listen(...)` returns.

## Alternatives considered

- **Fix the socket EACCES itself** (align volume uid/permissions on
  the shared `/var/run/govai` mount between `openclaude-runner` and
  `claude-code-runner`). Correct long-term but bigger blast radius;
  touches Dockerfiles and compose volume config. Deferred to a
  separate infra task — the availability-check fix is unrelated and
  can ship independently.
- **Remove unix socket entirely**, use only TCP. Would simplify but
  loses one security argument (TCP exposes a port network-wide;
  socket keeps it container-local). Rejected.
- **Live TCP probe on every availability call** (actually open a
  socket to the host:port). Slow and can block requests. Rejected
  — the adapter is the right place to do that, with its existing
  timeout and error handling.

## Consequences

- The UI now offers `Official` as available whenever the TCP host is
  configured (which is always true in the compose file). If the
  sidecar is truly down, the adapter fails at connect time with a
  specific gRPC error. Slightly worse UX in the "container not
  running" case compared to the old upfront rejection — but strictly
  more honest and matches how every other runtime route already
  behaves.
- Any future runtime that only supports unix sockets (no TCP) is
  unaffected: it will fail the socket check and has no TCP host to
  fall through to → still returns `false`.
- A new reality-check harness
  (`tests/integration/test-runtime-produces-artifacts.sh`) accompanies
  this fix and prevents the inverse regression — where "available"
  is true but tools silently don't execute. It verifies tool use via
  a unique random marker written by Write + read back by Bash cat;
  if the LLM invents the output instead of running the commands,
  the marker never appears and the test fails.

## Related

- `docs/HARD_RESET_REPORT_20260422_1959.md` — documents the
  uid-conflict observation on the shared volume.
- `docs/STREAM_HANDLER_INVESTIGATION_20260422_2113.md` — unrelated
  SSE/CORS bug fixed in 13.5a2; contemporaneous with this phase.
- Future 13.5b will tackle the Cerebras multi-turn timeout surfaced
  in the browser (tools execute but the final LLM turn sometimes
  times out when the agent does 3+ tool rounds).
