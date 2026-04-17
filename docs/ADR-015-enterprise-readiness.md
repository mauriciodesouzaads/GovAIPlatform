# ADR-015: Enterprise Readiness Deliverables

## Status: Accepted

## Context

Enterprise customers (banks, judiciary, government) require deliverables
beyond functional correctness before signing contracts. Four categories
regularly block sales otherwise:

1. **Kubernetes deployment** — customer's platform team runs everything on
   k8s and will not accept "you need to run docker compose yourself."
2. **SOC 2 Type II control evidence** — compliance team needs an auditor-
   friendly walkthrough without bespoke dev work.
3. **SIEM integration** — security team needs every policy/DLP/auth event
   streaming into Splunk/Elastic/Sentinel/Datadog in real time.
4. **Automated pentest evidence** — RFP always asks for recent pentest
   results; "we'll hire a firm" is a non-answer if the product can't
   demonstrate internal hardening.

FASE 12 ships all four in a single change so each sales conversation has
the artifact ready.

## Decision

### Claude Code Official runtime — validated

- Real E2E run against Claude Code CLI 2.1.112 with a $0.05 spend
- `bridge.js` updated for CLI 2.x flag changes:
  - `--max-turns` removed (does not exist in 2.x); replaced with
    `--max-budget-usd 0.50` (enforces per-call spend ceiling)
  - Added `--bare --no-session-persistence` (minimize overhead)
  - `stdio[0]='ignore'` to close stdin and avoid the 3s wait
- `Dockerfile` runs as non-root `node` user (CLI 2.x refuses
  `--dangerously-skip-permissions` under root)
- `docs/CLAUDE_CODE_CLI_STREAM_FORMAT.md` documents observed shape
- Probe-mode counter `govai_claude_code_probes_total` vs billable-call
  counter `govai_claude_code_billable_calls_total` for cost observability

### Kubernetes Helm chart (`deploy/helm/govai/`)

- Chart.yaml, values.yaml, values-prod.example.yaml, README.md
- Templates: api + admin-ui + openclaude-runner + claude-code-runner +
  litellm + presidio deployments and services; HPA for api and
  openclaude-runner; PDB for api and admin-ui; NetworkPolicy (zero-trust
  default-deny + explicit allows); migration-job as Helm pre-install/
  pre-upgrade hook
- `existingSecret` pattern — the chart NEVER generates secrets; customers
  create `govai-postgres-creds`, `govai-redis-creds`, `govai-llm-keys`,
  `govai-litellm-key`, `govai-jwt` via kubectl before install
- Precondition validation at render time: fails fast with clear messages
  when required values are missing or when multi-replica is misconfigured
- Validated: `helm lint` clean, `helm template` renders 21 k8s resources

### SOC 2 Type II pack (`docs/compliance/`)

- `SOC2_CONTROL_MAPPING.md` maps 8 Trust Service Criteria to specific
  code paths, migrations, tests, and Prometheus metrics
- `scripts/soc2-evidence.sh` auto-generates a CSV-and-README tarball
  covering the last N days of:
  - CC6.1 access events
  - CC6.6 DEK rotations
  - CC7.2 alert deliveries
  - CC8.1 policy version changes
  - C1.1 DLP events
  - A1.2 backup history
- `GET /v1/admin/compliance/access-review` endpoint — privileged-user
  roster with last-login and 90-day inactivity flag for quarterly reviews

### SIEM streaming

- Migration 080 extends `notification_channels.provider` with
  `siem_webhook` (JSON) and `siem_cef` (CEF v0)
- `src/lib/siem-formatters.ts`: CEF v0 + Elastic Common Schema (ECS)
  JSON formatters with severity/outcome inference
- `notification.worker.ts` dispatches every configured canonical event
  to SIEM channels alongside Slack/Teams
- Config per-org via admin UI — no code changes per customer
- Auth: optional `auth_header` for bearer tokens (Splunk HEC, etc.)

### Automated pentest suite

- `src/__tests__/pentest.suite.test.ts`: four attack categories
  (auth bypass, cross-tenant isolation, prompt injection, SQL injection)
  against a live API instance
- `scripts/pentest-report.sh` generates a Markdown report suitable for
  RFP attachment, combining the pentest suite with the existing 12+
  `security.*.test.ts` files
- Tests fail-close: any regression in a security boundary fails the suite

## Trade-offs

- **Helm chart is ~2k YAML lines** — unavoidable for a production chart.
  Kept in `deploy/helm/govai/` so docker-compose users never see it.
- **In-cluster Postgres supported only for dev/PoC.** Production MUST use
  RDS/Cloud SQL for RPO/RTO guarantees — chart README explicit about this.
- **CEF vs JSON:** CEF is ~5× smaller but less queryable. Customers pick
  per channel.
- **Pentest suite requires live API.** Skips cleanly when unreachable; CI
  must bring up the stack before running.
- **Claude Code CLI flag changes** may happen again in future versions.
  Bridge.js is documented to note validated version; regression test
  (`test-claude-code-official-e2e.sh`) catches breakage.

## Alternatives considered

- **Kustomize instead of Helm**: rejected — customer platform teams
  overwhelmingly prefer Helm for third-party apps.
- **Operator pattern**: overkill for v1; would add custom resource
  definitions and reconciler complexity for negligible benefit.
- **Split SOC 2 doc per framework (ISO, PCI, HIPAA)**: one file per
  criterion set is easier to maintain; the current doc cross-references
  those frameworks in the P1.1 section.
- **Running pentest suite nightly in CI against staging**: valuable but
  requires a dedicated environment + credential management; this ADR
  ships the suite, follow-up ADR can add the pipeline.

## Consequences

- Sales engineering can answer "Helm chart?" with a GitHub link
- Compliance team can hand auditors a tar.gz of evidence
- Security team can plug into an existing SIEM in under an hour
- RFP "recent pentest results" question answerable with concrete CI output
- Claude Code Official runtime is no longer theoretical — proven with
  real spend
