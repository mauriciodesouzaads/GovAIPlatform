# ADR-025: Claude Code Official — Leitura A deferral (FASE 14.0/3a)

**Status:** Accepted (Etapa 3a)
**Data:** 2026-04-25

## Context

The "Leitura A" invariant of FASE 14.0 says every LLM call must
traverse the governed gateway (LiteLLM proxy). This is what
`openclaude-runner` and `aider-runner` already comply with — they
inject `OPENAI_API_BASE` (or equivalent) so every model call hits
LiteLLM, which adds DLP, audit, rate limit, and tenant routing.

For `claude-code-runner` (the official Anthropic CLI sidecar), the
recon at the start of Etapa 3a found:

- The CLI 2.1.117 inside the container uses the standard Anthropic
  SDK envelope, which honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`.
- LiteLLM 1.x already exposes `/v1/messages` (the Anthropic Messages
  API shape) and a virtual model `govai-llm-anthropic` mapping to
  `anthropic/claude-sonnet-4-20250514`.
- Pointing `ANTHROPIC_BASE_URL=http://litellm:4000` made simple
  request payloads round-trip cleanly during the recon probe.

On that basis we initially adopted **Option α** — flip the runner's
env to LiteLLM passthrough — and rebuilt the stack.

## What broke

CLI 2.1.117 sends `thinking: adaptive` on **every** outbound
`/v1/messages` request, regardless of whether `--effort` is passed
on the command line. (Confirmed by manual probes inside the runner:
`claude -p --bare --model govai-llm-anthropic "say ok"` returns
HTTP 400 "adaptive thinking is not supported on this model" before
any user prompt is even processed.) `claude-sonnet-4-20250514` —
the model the LiteLLM alias resolves to — does not accept the
adaptive-thinking parameter. As a result, *every* Claude Code run
under Option α dies with the same 400 before producing any output.

The CLI offers no flag to disable adaptive thinking; `--effort`
only tunes the level (low/medium/high/xhigh/max), and even
`--effort low` keeps adaptive on.

The safest path back to a working runtime — given the explicit
scope rule for this etapa ("Não tentar ajustar LiteLLM config") —
was to revert the runner's env to talking directly to the real
Anthropic API. That is what this ADR records.

## Decision

For Etapa 3a, `claude-code-runner` is **exempt from Leitura A**.
Concretely:

```yaml
# docker-compose.yml (claude-code-runner.environment)
ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}    # real Anthropic key
# ANTHROPIC_BASE_URL intentionally NOT set — defaults to api.anthropic.com
```

Audit trail for Claude Code calls is therefore **partial** while
this exception is in force:

- ✅ `tool_use` events (Bash, Read, Write, Edit, …) are captured by
  the gRPC adapter and persisted in `runtime_work_item_events` with
  `event_type` ∈ {`TOOL_START`,`TOOL_RESULT`,`RUN_STARTED`,…}.
- ✅ Workspace filesystem mutations are captured (the runner runs
  inside a sandboxed `/tmp/govai-workspaces/<org>/<workspace>`).
- ✅ Token usage is reported back via `FinalResponse.prompt_tokens`/
  `completion_tokens`, contributing to tenant_quota.
- ✅ Trace ID propagates per `runtime_work_items.id`.
- ❌ Raw prompt and raw model response do **not** go through DLP.
- ❌ Per-tenant rate limit / fallback group routing on the LLM
  hop does **not** apply.

`openclaude-runner` and `aider-runner` remain fully Leitura-A
compliant — only the Claude Code lane is exempt.

## Mitigations

- Shield level ≥ 2 still gates dangerous tools via HITL approval
  *before* the CLI runs.
- The api-side governance pipeline (OPA, the assistant's
  `delegation_config`, runtime profile resolution) runs unchanged
  — the exception applies *only* to the LLM-call hop *inside* the
  CLI's process.
- The session-index in Redis (`runtime:sessions:<orgId>`) and the
  per-work-item event timeline give operators full visibility of
  what tools ran, with what arguments, and what they returned.

## Future — when do we re-enable Option α?

Any one of the following unblocks reverting to LiteLLM passthrough:

1. **LiteLLM exposes a model alias backed by a thinking-capable
   model** (e.g. `claude-sonnet-4-5-20250929` or newer). At that
   point flipping the env block back is a 3-line change to
   `docker-compose.yml`.
2. **CLI version pinned to a release that doesn't default to
   adaptive thinking**, or that exposes a flag to disable it
   explicitly. (Pinning the CLI is itself a non-trivial change —
   today the `Dockerfile` does `npm install -g @anthropic-ai/claude-code`
   without a version pin.)
3. **Anthropic ships a forward-compat path** where older models
   silently ignore the adaptive-thinking parameter instead of
   400-ing — equivalent to LiteLLM stripping it before
   forwarding.

The wiring for thinking events (proto extension, adapter listener,
Redis index, UI renderer) all stays in place. When the model on the
hot path starts emitting `thinking` blocks, `THINKING` events show
up in `runtime_work_item_events` with zero code change.

## Consequences

- The reality-check `tests/integration/test-claude-code-thinking-and-sessions.sh`
  treats the **sessions** invariants as hard-required and the
  **thinking** invariants as soft-skipped: passing means
  "session_id round-trips and resume works"; THINKING events
  count is reported but does not fail the test.
- Etapa 3a delivers session persistence + the protocol foundation;
  the user-facing "Claude pensando" feature is dormant until the
  model situation above changes.
- Audit reports for Claude Code runs must explicitly note the
  partial-DLP coverage while this ADR is in force.
