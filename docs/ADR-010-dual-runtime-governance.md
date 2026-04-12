# ADR-010: Dual Runtime Governance

## Status: Accepted

## Context

The GovAI platform supports AI assistants backed by different runtime engines.
Two modes are needed: official (Anthropic Claude Code) and open (OpenClaude
multi-provider). Both must be governed identically — DLP, policy, approval
bridge, evidence, audit, finops — but the user must be able to choose which
engine executes their task.

## Decision

Support two governed runtime modes under a single control plane:

### Open Governed (`openclaude`)
- Runtime aberto multi-provider via OpenClaude
- gRPC headless with approval bridge
- Claim: `open_governed`
- Always available as safety net (Groq → Cerebras → Gemini → Ollama fallback)

### Official CLI (`claude_code_official`)
- Claude Code CLI in `-p` (print/non-interactive) mode
- gRPC bridge (`claude-code-runner/bridge.js`) maps stdout to unified event grammar
- Claim: `official_cli_governed` (see ADR-011 for distinction from `exact_governed`)
- Available only when ANTHROPIC_API_KEY has credits AND sidecar container is running

### Resolution Order (5 layers — FASE 8)

1. **explicit_request** — user selected in chat sidebar or API parameter
2. **case_selected** — persisted on the demand_case
3. **template_fixed** — configured on the workflow template (mode='fixed')
4. **assistant_default** — preference on the assistant record
5. **tenant_default** — org-wide binding via `runtime_profile_bindings`
6. **global_fallback** — `openclaude` (always)

### Unavailability rules

- **Explicit selection + unavailable** → HTTP 503 `RUNTIME_UNAVAILABLE`, NEVER silent fallback
- **Implicit layers (assistant/tenant/global)** → skip unavailable, fall through silently
- This ensures the user always knows which engine is actually running their task

### Audit

- Every switch recorded in `runtime_switch_audit`
- `claim_level` frozen on each `architect_work_items` row at dispatch time
- `runtime_source` + `runtime_fallback_applied` stored in `execution_context`

### Event grammar (unified across both runtimes)

Both runtimes emit the same event types via the gRPC adapter:

| Event | Emitted | Notes |
|-------|---------|-------|
| `RUN_STARTED` | Yes | First event on every run |
| `TOOL_START` | Yes | Tool invoked by the model |
| `TOOL_RESULT` | Yes | Tool returned |
| `ACTION_REQUIRED` | Yes | Waiting for approval |
| `ACTION_RESPONSE` | Yes | Approval decision |
| `RUN_COMPLETED` | Yes | Terminal success |
| `RUN_FAILED` | Yes | Terminal error |
| `TEXT_CHUNK` | No | Deliberately omitted — too high-frequency for the event store. Accumulated into `fullText` on the done event instead. |
| `RUN_CANCELLED` | Implicit | Recorded as status='cancelled' on the work item; no dedicated event row. |

## Consequences

- Every work item records its runtime profile slug and claim level
- The UI shows distinct badges: `🔒 Official CLI` vs `🌐 Open`
- The playground selector is session-scoped (not persisted to assistant)
- Official runtime requires active ANTHROPIC_API_KEY + running container
- `exact_governed` is reserved for future Agent SDK implementation (ADR-011)
- Health probes use Redis-cached socket checks (30s TTL) for the `/runtimes` list
