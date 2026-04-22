# ADR-020: Three-Tier Shield Levels

## Status: Accepted

## Context

Before FASE 13.5a, the platform ran a single governance posture
equivalent to what this ADR calls **Level 3 (Blindagem Máxima)**:

- Every runtime tool use (Claude Code, OpenClaude) was classified in-
  flight and destructive tools paused the work item in
  `awaiting_approval` until an operator clicked Approve.
- Segregation of duties was hard-coded into formal-action routes
  (policy publish, risk assessment, security exceptions).

This posture is correct for a bank or judicial customer pursuing SOC 2
Type II, but it **blocked the product from working "out of the box"**
for every other segment:

- PMEs evaluating the platform hit the approval pause on their first
  agent run and couldn't continue without setting up an approval chain.
- Multinationals doing internal pilots saw tool executions freeze in
  demos.
- Integration tests that used to be idempotent (`test-openclaude-e2e.sh`)
  became flaky because they'd race the pause.

We also learned, empirically, that customers don't want twelve
per-feature flags. They want a single dial: "how strict?"

## Decision

Introduce `shield_level ∈ {1, 2, 3}` as a single integer on
`organizations` (default 1) and optionally on `assistants` (nullable
override, upward-only via DB trigger).

The three levels are documented in `docs/ASSURANCE_MODES.md`:

- **Level 1 (Fluxo Livre)** — DLP + audit + cost caps only. Runtimes run
  natively: the runtime's own tool-use dialog IS the authorization.
- **Level 2 (Conformidade)** — Level 1 + SoD on formal actions.
- **Level 3 (Blindagem Máxima)** — Level 2 + tool-use classification and
  HITL on destructive tools. Exactly the pre-13.5a behavior.

### Why default = 1

Every greenfield deploy should start at level 1 so the product "just
works". Customers pursuing compliance opt into level 2 or 3 deliberately,
with a documented acknowledgment (and an evidence record capturing the
markdown notice version they accepted). Defaulting to 3 would mean every
demo/PoC hits gates the prospect has no context to interpret.

### Override direction: upward only

`assistants.shield_level` defaults NULL (inherit). If set, it must be
`≥ org.shield_level`. Enforced by the trigger
`enforce_assistant_shield_level_gte_org`.

The upward-only rule prevents a subtle regression: if an org sets
level 3 for compliance reasons, a careless admin must not be able to
dial a single assistant down to 1 and quietly run ungated agents. The
effective level is always `max(assistant, org)`.

### Change flow with acknowledgment + hash

A change from one level to another requires:

1. UI fetches the notice markdown via
   `GET /v1/admin/shield-level/notice?from=X&to=Y&locale=Z`.
2. Backend returns the content + SHA-256 hash.
3. UI renders the markdown, user checks an acknowledgment box.
4. UI POSTs `{ new_level, template_hash, acknowledgment, locale }`.
5. Backend re-reads the notice file and compares hashes. Mismatch →
   409 Conflict (the text changed mid-flow; reload).
6. On match, `organizations.shield_level` updates and an immutable
   `evidence_records` row is written in category
   `shield_level_change` with all the provable metadata.

The hash ties the legal text an auditor recomputes from Git to the
exact bytes the user saw in the UI at decision time. Stronger than
"user clicked OK".

### Single-gate library

`src/lib/shield-level.ts` exposes:
- `resolveShieldLevel(pool, orgId, assistantId?)` — DB lookup with
  precedence
- `requiresApproval(action, level)` — the full matrix in one function
- `requiresHitlForTool(level)` — convenience alias for the hot path

Call sites route through this library, so adding a new governed
action in the future is a one-line matrix update.

### Gate preservation at level 3

The classic pipeline in `architect-delegation.ts` —
`approval_mode` → `auto_safe` → `resolveToolDecision` → awaiting_approval
— is **not removed**. It sits behind the `requiresHitlForTool(level)`
check. Level 3 still hits every branch; level 1/2 short-circuits to a
native `respond(data.prompt_id, 'yes')` + audit-only evidence.

Zero refactor. Zero regression for existing customers who rely on
level-3 behavior.

## Trade-offs

- **Level 1 is not SOC 2 compliant for SoD-dependent controls.**
  Being explicit in `SOC2_CONTROL_MAPPING.md` is non-negotiable — we
  won't let customers think Level 1 fulfills SOC 2 CC6.1 / CC7.2 /
  CC8.1 when it doesn't. The notice template for "any level → 1" makes
  this consequence prominent.

- **Fail-open on level resolution.** If the DB lookup throws, we
  return 1 (least restrictive). Rationale: failing closed (level 3)
  would cascade into deny-by-default behavior across every route
  every time the DB had a transient glitch. The audit trail still
  captures the actual level applied via `recordEvidence()`.

- **Policy publish / risk / exception gates not uniformly gated in
  this phase.** Those routes don't currently run a SoD flow to gate —
  the infrastructure exists elsewhere (approvals worker, etc.) but
  isn't plumbed uniformly. FASE 13.5b will add the
  `requiresApproval('policy_publish', level)` etc. call sites in a
  dedicated pass. Today, level 2 and 3 do NOT introduce a new SoD
  gate where none existed; they only preserve the existing level-3
  behaviors (= runtime tool HITL), which remain unchanged.

- **Three levels, not more.** A fourth level ("paranoid: everything
  also needs DLP manual review") was considered and rejected —
  adoption curves flatline past three. Three levels already cover
  "demo to regulated bank" in one step.

## Alternatives considered

- **Two levels (free/strict)**. Rejected: customers pursuing
  SoD-without-HITL (common in mid-market fintechs) have no home.

- **Per-feature flags** (one boolean per governance control).
  Rejected: combinatorial explosion of 2^N postures, most of which are
  nonsense. Customers asked for presets.

- **Granular policy DSL** (an OPA-like rule set governing each
  governed action). Possible as a future level-4 "custom" option, but
  premature without a customer demanding it.

- **Default = 3, opt-out to 1**. Rejected: defaulting to gated
  behavior breaks the out-of-box product experience for the majority
  of users. Opt-in to stricter is safer than opt-in to looser.

## Consequences

- Runtimes (Claude Code Official, OpenClaude) run natively at default
  level 1 — the original 13.5a objective.
- Existing customers who deployed under level-3 behavior continue to
  see identical behavior as long as their stored `shield_level` is 3.
  The migration sets default 1 for fresh rows and does not backfill
  existing orgs — for a customer migrating from pre-13.5a, an admin
  must deliberately step through the change flow to go down to level
  1 (with full acknowledgment + evidence).
- A follow-up (13.5b) adds uniform SoD call sites so level 2 and 3
  gate policy/risk/exception flows consistently.
- A follow-up (13.5c) wires a UX "dry-run at a higher level" so
  customers can see what would have paused before they commit.
