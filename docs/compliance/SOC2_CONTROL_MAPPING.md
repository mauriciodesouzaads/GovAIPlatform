# SOC 2 Type II Control Mapping — GovAI GRC Platform

Maps the AICPA Trust Services Criteria to specific implementations,
configurations, and evidence sources in the GovAI platform. Intended for
auditors and customer compliance reviews.

Platform version reference: `git log -1 --format='%H'` captures the exact
revision the evidence below was collected against.

> ## Compliance posture depends on Shield Level
>
> As of FASE 13.5a, `organizations.shield_level` controls which gates
> run. **Segregation of duties is enforced only at `shield_level ≥ 2`.**
>
> Organizations operating at **Level 1 (Fluxo Livre)** accept sole-actor
> governance — actions are still fully audit-logged but a single
> operator can request AND approve the same formal action. Level 1 is
> **not SOC 2 Type II compliant** for the SoD-dependent controls listed
> below (CC6.1, CC7.2, CC8.1).
>
> Organizations pursuing SOC 2 certification should operate at
> **Level 2 (Conformidade)** or **Level 3 (Blindagem Máxima)**. See
> `docs/ASSURANCE_MODES.md` for the full matrix and
> `docs/ADR-020-shield-levels.md` for the decision rationale.

---

## CC6.1 — Logical Access Controls

### Implementation
- JWT-based authentication with role-based access control. Roles:
  `admin`, `operator`, `dpo`, `auditor`, `consultant`.
  Source: `src/server.ts` (`requireRole`), `src/routes/admin.routes.ts`
- **Row-Level Security** on 60+ tables, enforcing `org_id` isolation.
  Every query sets `app.current_org_id` via `SET` before reading tenant
  data. Source: migrations `019`, `034`, `035`, `058`, `077`, `078`, `079`.
- **Password hashing** via bcrypt cost 12. Source: `src/lib/auth-oidc.ts`.
- **OIDC federation** for enterprise SSO (Okta, Entra ID, Google).
  Source: `src/routes/oidc.routes.ts`.

### Evidence
- `audit_logs_partitioned` records every auth event:
  `action='LOGIN_SUCCESS'`, `'LOGIN_FAILURE'`, `'ROLE_CHANGE'`.
- Automated tests enforce the control:
  `src/__tests__/security.rbac.test.ts` (role gates on admin routes),
  `src/__tests__/security.tenant-isolation.test.ts` (RLS cross-tenant queries).

### Audit SQL (last 90 days)
```sql
SELECT action, count(*), min(created_at), max(created_at)
FROM audit_logs_partitioned
WHERE action IN ('LOGIN_SUCCESS','LOGIN_FAILURE','ROLE_CHANGE')
  AND created_at > NOW() - INTERVAL '90 days'
GROUP BY action ORDER BY count(*) DESC;
```

---

## CC6.6 — Encryption in Transit and at Rest

### Implementation
- **TLS in transit:** ingress enforces TLS 1.2+; LiteLLM and gRPC runners
  are cluster-internal only.
- **Encryption at rest** for run payloads via envelope encryption.
  DEKs wrapped with a per-org master key. Source:
  `src/lib/crypto-service.ts`, migration `014`, `018`.
- **DEK rotation** with HMAC-SHA256 integrity verification. Source:
  `src/jobs/key-rotation.job.ts`.

### Evidence
- `run_content_encrypted` table — every delegated run encrypted before
  storage.
- `govai_dek_rotations_total` + `govai_dek_rotation_errors_total`
  Prometheus metrics.
- `src/__tests__/security.audit-crypto.test.ts` — verifies HMAC.

---

## CC7.2 — System Monitoring

### Implementation
- **Prometheus metrics** exposed at `/metrics` (bearer-token gated via
  `METRICS_API_KEY`). Source: `src/lib/sre-metrics.ts`.
- **OpenTelemetry tracing** (opt-in via `OTEL_ENABLED=true`). Source:
  `src/lib/tracing.ts`.
- **Structured JSON logs** with trace correlation. Source:
  `src/lib/structured-log.ts`.
- **Alert thresholds per org** persist to `organizations.alert_thresholds`
  (JSONB); evaluated every 60s; breaches flow through
  `notification_channels`. Source: `src/workers/alerting.worker.ts`.

### Evidence
- Grafana dashboards: `deploy/grafana-dashboards/`.
- Prometheus alert rules: `deploy/prometheus/alerts.yaml`.
- ADR-013 (observability strategy).

---

## CC7.3 — Incident Response

### Implementation
- 10+ canonical incident event types delivered via
  `notification_channels`: `policy.violation`, `dlp.block`,
  `execution.error`, `alert.high_latency`, `alert.high_violation`,
  `alert.high_cost`, `risk.assessment_completed`, `approval.pending`,
  `approval.granted`, `approval.rejected`.
- **SIEM streaming** (FASE 12) supports direct integration with
  Splunk/Elastic/Datadog/Sentinel via CEF or JSON.
- Operational runbooks: `docs/RUNBOOKS.md`.

### Evidence
- `notification_channels` table — customer-configured integrations per org.
- `webhook_deliveries` table — every alert delivery with success/failure.

---

## CC8.1 — Change Management

### Implementation
- **Immutable policy versions**. Each `policy_versions` row carries a
  SHA-256 `policy_hash`. Source: migration `011`, `042`.
- **Version diff endpoint** for audit trail:
  `GET /v1/admin/policies/:id/diff/:otherId`.
- **Review tracks** (multi-track approval) via `review_tracks` table.
- **Policy exceptions** with mandatory expiration via `policy_exceptions`.
  Source: migration `043`.

### Evidence
- `schema_migrations` table tracks every migration applied.
- `policy_snapshots` table — every execution links to a hash-addressed
  snapshot, proving what policy was active at time T.

---

## C1.1 — Confidentiality

### Implementation
- **DLP engine** with 7 detectors (CPF, CNPJ, phone, email, credit card,
  IBAN, IP address). Source: `src/lib/dlp-engine.ts`.
- **Presidio integration** for broader PII identification.
- Per-tenant data isolation via RLS (see CC6.1).

### Evidence
- `govai_dlp_detections_total` Prometheus counter.
- `audit_logs_partitioned.action='DLP_BLOCK'` entries.
- `src/__tests__/security.dlp-leaks.test.ts` — verifies data does NOT
  cross tenants.

---

## A1.2 — Availability

### Implementation
- **Horizontal scaling** via k8s HPA (Helm `autoscaling.api.enabled`).
- **Redis pub/sub stream registry** for multi-replica approval routing
  (ADR-012).
- **Circuit breaker per runtime** (FASE 11). Source:
  `src/lib/circuit-breaker.ts`.
- **Workspace TTL** + periodic cleanup prevents disk exhaustion.
  Source: `src/workers/architect.worker.ts` cleanup cron.
- **Watchdog** for stuck work items (FASE 11). Source:
  `src/lib/architect-delegation.ts:detectAndMarkStuckWorkItems`.

### Evidence
- Prometheus `up` metric + alert rules.
- Health endpoint `/health` returns 503 when degraded.
- **Daily automated backup** with 7-day rotation: `scripts/backup-db.sh`.
- **Weekly restore validation**: `scripts/test-restore.sh`.
- `docs/ADR-014-resilience-patterns.md` documents RPO (24h) + RTO (<15min).

---

## P1.1 — Privacy (LGPD / GDPR / EU AI Act)

### Implementation
- **Telemetry consent per org** (LGPD Art. 7, I): `organizations.telemetry_consent`.
- **Data retention** per org via `org_retention_config` (migration 064).
- **Right to erasure**: `DELETE /v1/admin/organizations/:id` cascades.
- **Evidence records** with retention class: `evidence_records.retention_class`.
- **Compliance frameworks** (LGPD, EU AI Act, ISO 42001) auto-mapped:
  migration `067`.

### Evidence
- `govai_compliance_consented_orgs` Prometheus gauge.
- `compliance_frameworks` table.
- Compliance Hub UI — auto-assessments per framework.

---

## Audit Package Generation

Run quarterly to produce an auditor-ready package:

```bash
bash scripts/soc2-evidence.sh [start-date] [end-date]
# → /tmp/govai-soc2-evidence-YYYYMMDD.tar.gz
```

The tarball contains CSV exports of access events, policy changes, alert
deliveries, DLP events, backup history, and encryption rotations —
structured for direct auditor review.
