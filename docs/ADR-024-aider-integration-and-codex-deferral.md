# ADR-024: Aider integration + Codex deferral

## Status: Accepted — FASE 13.5b/3

## Context

Maurício (product owner) asked to grow the runtime roster beyond
OpenClaude and Claude Code Official. The original ask mentioned
Cursor. Investigation during 13.5b:

- **Cursor** doesn't ship an official CLI. It's a desktop IDE. The
  only programmatic surface is a cloud API in closed beta. Wrapping it
  would put an unsupported provider in our critical path. Rejected.
- **OpenAI Codex CLI** exists and works, but it hardcodes the OpenAI
  endpoint. It does not accept a custom `OPENAI_API_BASE` that points
  at our LiteLLM proxy. Integrating it today means either (a) letting
  Codex talk directly to OpenAI, bypassing the GovAI gateway, or
  (b) forking Codex. Both bypass the central invariant of this product
  ("every LLM call goes through the governed proxy"). Rejected for
  this phase.
- **Aider** (https://aider.chat) is an opensource Python CLI agent
  with an active community, git-aware by design, and uses standard
  OpenAI-compatible environment variables. Pointing it at LiteLLM is
  a two-env-var change. Accepted.

## Decision

### Integrate: Aider

Build a new `aider-runner` container that wraps the Aider CLI behind
the same gRPC contract (`openclaude.v1.AgentService.Chat`) already
spoken by `openclaude-runner` and `claude-code-runner`. Key points:

- **Transport / governance**: same socket + TCP pattern from
  13.5b/0. Own uid (1002), own socket volume. No cross-container
  EACCES possible.
- **LLM routing**: the runner inherits `OPENAI_API_KEY` + `OPENAI_API_BASE`
  from env and hands them to Aider via the standard OpenAI SDK
  lookup path. All Aider LLM calls go through our LiteLLM proxy —
  DLP, rate-limit, audit, shield-level policy all apply.
- **Model default**: `govai-llm-cerebras` (same as openclaude-runner
  today). Override per-deployment via `AIDER_DEFAULT_MODEL`.
- **Workspace**: mounted at `/workspace` inside the container;
  the adapter sets `working_directory` per session the same way as
  for the other runtimes. Aider may create git commits inside that
  dir — a useful differential capability over the other two runtimes.

Visibility: a migration (086) registers `aider` in `runtime_profiles`
with `claim_level=open_governed` and the standard transport env-var
names. The UI's runtime selector picks it up automatically from
`/v1/admin/runtimes` — no UI code change needed.

### Defer: OpenAI Codex

Adding Codex today means violating the gateway invariant. That
invariant is the product's primary positioning ("sala segura para
uso de IA"). A runtime that exits the perimeter to reach OpenAI
directly makes every audit field pointing at that work item a lie.

**Revisit Codex when any of these land:**

- OpenAI ships support for custom `OPENAI_API_BASE` in the Codex CLI
  (track their release notes).
- We invest in a Codex-specific sidecar that rewrites outbound calls
  back through LiteLLM. That's a real project and needs its own ADR.
- A customer explicitly accepts the governance gap for Codex
  specifically, in writing, via a policy exception. Not blanket.

## Alternatives considered

- **Integrate Codex with a warning banner** — rejected. Audit trails
  are read by compliance tooling, not humans who see banners.
  Silent-failure of controls is worse than no control.
- **MITM proxy that intercepts Codex traffic** — technically feasible
  but introduces a new attack surface for a single CLI. Reviewers
  would rightly reject this.
- **Build our own thin "Codex-alike" inside openclaude-runner** —
  muddies what each runtime represents. Defeats the "multi-runtime
  experiment" goal.
- **Skip Aider too, focus on stabilizing the two existing runtimes** —
  rejected because Aider gives us a distinct value bullet (git-native
  editing agent, opensource, opt-in workflow) that OpenClaude and
  Claude Code Official don't cover. Shipping it costs one container
  + one migration and keeps all invariants.

## Consequences

- The chat runtime selector now lists three options. Users who want
  structured repo edits with auto-commit have a first-class path.
- The codebase carries one more Dockerfile (`aider-runner/`) and one
  more socket volume. Infrastructure cost is trivial.
- The gateway invariant is intact. Every LLM call from every runtime
  still lands on LiteLLM, still passes through the shield-level
  policy engine, still gets audit-logged with a runtime tag.
- Codex users are explicitly unsupported for now. When a customer
  asks, we point at this ADR + the fork/sidecar options in
  "Revisit when".

## Follow-ups (not in 13.5b)

- Reality-check harness variant that forces `runtime_profile=aider`
  and validates a git commit as additional evidence. Scheduled for
  13.5c along with the full refactor of architect-delegation.ts
  (see 13.5b/1 deprecation header).
- Per-runtime model recommendations surfaced in the UI
  ("this assistant works best with X on Aider"). Requires schema
  work. Separate phase.
- Documentation page under `docs/runtimes/aider.md` describing when
  to pick Aider vs OpenClaude vs Claude Code Official. Authoring
  pending real usage feedback.
