# Shield Levels (Assurance Modes) — FASE 13.5a

GovAI ships three levels of governance intervention. Each level is a
*preset* that controls DLP pass-through, human-in-the-loop gates, and
segregation of duties. Customers pick one per organization; individual
assistants may opt into a higher level than their org, never lower.

## Level matrix

| Control | L1 — Fluxo Livre | L2 — Conformidade | L3 — Blindagem Máxima |
|---|:-:|:-:|:-:|
| DLP blocks prompts/responses with PII | ✅ | ✅ | ✅ |
| Cost cap + rate limit | ✅ | ✅ | ✅ |
| Full audit log | ✅ | ✅ | ✅ |
| Policy violations → deny | ✅ | ✅ | ✅ |
| ICP-Brasil optional (opt-in per evidence record) | ✅ | ✅ | ✅ |
| Bias detection optional (opt-in per version) | ✅ | ✅ | ✅ |
| **Segregation of duties** on formal actions | ❌ | ✅ | ✅ |
| **Runtime tool-use classification** | ❌ | ❌ | ✅ |
| **HITL pause on destructive tools** | ❌ | ❌ | ✅ |

"Formal actions" covered by SoD at level 2+:
- Policy publication
- Risk assessment finalization
- Security exception approval

"Destructive tools" gated by HITL at level 3:
- File writes, shell execution, network requests
- Any tool not in the `SAFE_READ_ONLY_TOOLS` allowlist

Runtimes affected (levels 1/2 run natively, level 3 pauses):
- Claude Code Official CLI via gRPC bridge
- OpenClaude sandbox

## Decision guide

**Pick Level 1** if you:
- Are a small/medium team evaluating the platform
- Want the product to work like a normal LLM gateway "out of the box"
- Need fast iteration with audit trail but no compliance-grade gates
- Are not pursuing SOC 2 / ISO 27001 / bank-grade audit in the near term

**Pick Level 2** if you:
- Need SoD on formal actions for internal or industry compliance
- Have ≥ 2 operators available to form an approval chain
- Don't need (or don't want the latency of) per-tool HITL on agents

**Pick Level 3** if you:
- Are operating in a regulated industry (bank, judiciary, health) that
  requires tool-level auditability + approval
- Pursue SOC 2 Type II on full CC6.1 / CC7.2 / CC8.1 controls
- Can staff approvers in real time during agent workloads

## Level is one knob, not many

The single `shield_level` integer replaces what used to be a
combinatorial sprawl of per-feature flags. A SaaS customer cannot mix
"no HITL, but SoD on policies, but also classify tools". That
combination doesn't correspond to any useful compliance posture. The
three levels enumerate the postures that actually matter.

## How to change

1. Navigate to **Settings → Nível de Proteção** (admin or DPO only).
2. Click "Alterar para este nível" on the target level.
3. The UI renders the markdown notice for the transition
   (`docs/legal/shield_notices/{locale}/level_X_to_Y.md`).
4. Read it, check the acknowledgment box, click "Confirmar mudança".
5. Backend validates the SHA-256 hash the UI posted matches the file
   on disk, updates the column, and writes an immutable
   `evidence_records` row in the `shield_level_change` category.

The evidence record captures:
- `from_level`, `to_level`
- `template_hash` — the exact notice text version the user saw
- `template_locale`
- `acknowledgment` — the UI's acknowledgment string
- `actor_id` + `actor_email` + `created_at`

## Auditor reproducibility

An external auditor can:
1. Fetch an `evidence_records` row in category `shield_level_change`.
2. Read `metadata.template_hash` and `metadata.template_locale`.
3. Compute `sha256` of the committed file at
   `docs/legal/shield_notices/{locale}/level_{from}_to_{to}.md` in the
   Git ref matching the platform version at `created_at`.
4. Match the two hashes — the transition is provable.

If the notice text is ever edited, bump the front-matter `version`
and commit. New changes start producing a new hash; old evidence
records still reference the old hash, still verifiable against the
Git history.

## What if an organization is at Level 1 but an assistant needs Level 3?

Set the assistant's `shield_level = 3`. The DB trigger
`enforce_assistant_shield_level_gte_org` guarantees an assistant can
only be higher than its org, never lower — so a single high-risk
agent can run at tight controls inside an otherwise permissive org.
The effective level is `max(assistant.shield_level, org.shield_level)`.

## Follow-ups (scope of 13.5b+)

- Unify SoD enforcement across policy publish / risk / exception
  routes under a single `requiresApproval(...)` helper (the library
  exists; call sites are still per-route).
- Per-assistant change notice UX (today, `assistants.shield_level`
  changes directly via admin API — acceptable because only admins can
  touch it, but a notice-UX makes the decision auditable).
- Cross-level migration tooling (e.g., "dry-run level 2 against my
  current traffic to see which actions would have paused").
