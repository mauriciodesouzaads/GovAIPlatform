# ADR-016: Model Bias Detection

## Status: Accepted

## Context

Compliance officers at banks, judiciary, and government customers need
defensible evidence that the AI assistants they deploy do not
discriminate against protected groups. Two regulations drive this
directly:

- **EU AI Act Art. 10** — "Data governance and management": high-risk
  systems must undergo examination for possible biases.
- **LGPD Art. 20** — the data subject's right to ask for review of
  automated decisions; the controller must demonstrate due diligence
  including fairness testing.

Incumbents already ship this as a headline feature:

- **CredoAI** — "Fairness Assessment" reports per model version
- **Holistic AI** — "Bias audit" with demographic_parity + equalized_odds
- **IBM Watson OpenScale** — continuous fairness monitoring

GovAI had nothing here before FASE 13.1. Sales conversations hitting
RFPs from banks consistently lost points on this bullet.

## Decision

Each `assistant_version` carries zero or more `bias_assessments`. The
four standard fairness metrics are computed deterministically from
per-group aggregated counts submitted by a reviewer (operator, DPO, or
auditor role). Verdict is one of `pass | warn | fail`; `fail` emits a
notification through the existing channels (Slack, Teams, SIEM, email)
and mirrors onto `assistant_versions.latest_bias_verdict` for cheap
list queries.

### Metrics

| Metric | Definition | Fail condition (default) |
|---|---|---|
| `demographic_parity` | max pairwise \|P(ŷ=1\|A=i) − P(ŷ=1\|A=j)\| | > 0.1 |
| `statistical_parity` | same numeric value, labelled separately for UI | — |
| `disparate_impact` | min(positive_rate) / max(positive_rate) | < 0.8 OR > 1.25 |
| `equalized_odds` | max(TPR_diff, FPR_diff) across groups | > 0.1 |

`equalized_odds` is computed only when every group exposes the full
confusion matrix (TP, FP, TN, FN). When omitted, the metric is
`undefined` rather than `0` — auditors reading a report can
distinguish "not applicable" from "passed".

The 80% rule (disparate_impact ≥ 0.8) is the US EEOC standard and the
closest thing to a universally accepted fairness floor. `≤ 1.25` is
its symmetric upper bound, catching the inverse situation where the
reference group is disadvantaged.

### Verdict calculus

- `pass` — zero violations
- `warn` — exactly one violation (actionable signal, not a gate)
- `fail` — two or more violations (hard stop when
  `assistant_versions.bias_assessment_required = true`)

### Evidence chain

Each assessment submission records an HMAC-signed `evidence_records`
row (category `bias_assessment`) whose `metadata` contains metrics,
violations, thresholds, dataset size, and protected attributes. The
assessment row stores `evidence_record_id` so the HMAC hash can be
retrieved by auditors via
`GET /v1/admin/bias-assessments/:id/evidence`.

### Table structure

Key decisions in migration `081_bias_assessments.sql`:

- `protected_attributes` as `jsonb` array — flexibility over time
  (e.g., adding "religion", "nationality") without migrations.
- `group_breakdowns` as `jsonb` object — the raw input is preserved so
  auditors can recompute metrics from first principles, independent of
  our code.
- `(assistant_version_id, test_dataset_name)` unique — prevents
  reporting the same dataset twice against the same version (use a
  different name for re-runs).
- RLS `org_isolation_bias` — standard set_config-based policy, same
  pattern as every other tenant-isolated table.
- **No denormalized mirror on `assistant_versions`.** We originally
  considered caching the latest verdict onto the version for cheap
  list queries, but `assistant_versions` is Cartório-immutable
  (`prevent_version_mutation` trigger blocks every UPDATE). Rather
  than weaken that invariant, list views derive the latest verdict
  on read via a `LATERAL` / correlated subquery on
  `bias_assessments`. The `(org_id, verdict)` and
  `(assistant_version_id)` indexes keep this cheap.

## Trade-offs

- **Aggregated counts instead of row-level data.** We accept only the
  per-group counts, not the individual predictions. This means the
  platform does not ingest customer data for fairness testing — the
  customer runs inference against their own test set and submits the
  summary. Pro: no sensitive-data retention risk, no pipeline to
  maintain. Con: the platform cannot detect accidentally-swapped or
  cherry-picked counts. Evidence HMAC at least freezes the submitted
  numbers so tampering is detectable after the fact.

- **Verdict thresholds are per-assessment, not per-org.** Each
  submission carries its own thresholds object (defaulting to the
  canonical values). Rationale: different regulated domains have
  different floors (EEOC 80% vs. hiring-specific stricter norms), and
  forcing an org-wide setting would make it harder to comply with
  multiple regimes simultaneously.

- **Single language / metrics set.** We implement four metrics,
  not twelve. Adding more (calibration, counterfactual fairness, etc.)
  is opt-in code; we would rather ship the canonical four well than
  surface twelve that nobody trusts.

- **No UI for row-level fairness.** Scanning a customer's
  prediction log and computing fairness automatically would be useful
  but requires an ingestion pipeline + retention controls. Deferred
  until an enterprise customer asks for it.

## Alternatives considered

- **Use an off-the-shelf library (fairlearn / aequitas).** Both are
  Python; embedding them would mean a Python sidecar or a fetch to
  Presidio-style service. The metrics themselves are ~150 lines of
  TypeScript — not worth the operational complexity of another
  runtime.

- **Store raw predictions and compute on the server.** Rejected:
  privacy / retention liability, and customers with sensitive
  prediction logs (banking) would not ship them to us anyway.

- **Make bias assessment mandatory on every publish.** Too strict for
  internal-only assistants (classification=internal, no PII). The
  `bias_assessment_required` flag is defaulted `false` and flipped per
  version by the owner when the risk profile justifies it. A
  follow-up ADR can add org-level defaults once there is enough
  operational data to set them.

- **Emit fairness scores as Prometheus metrics.** Considered but
  deferred: a scraping target exposing counts-per-verdict adds
  observability but not governance. The audit view (via
  evidence_records and the API) is the primary consumer.

## Consequences

- RFP "Do you detect bias?" answerable with a live UI + evidence
  export + ADR link.
- SOC 2 / ISO 27001 auditors get an immutable trail per version.
- `latest_bias_verdict=fail` becomes a candidate gate for future
  publish flows (opt-in per version).
- Follow-up work: org-level default thresholds, scheduled
  re-assessment cadence, cross-version diff visualization.
