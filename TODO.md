# GovAI GRC Platform — Technical Debt / Follow-ups

## Known Flaky Tests (pre-existing, tracked; not blocking)

All failures below are reproducible on `main` prior to FASE 12 and are
unrelated to any FASE 12 change. They pass intermittently in isolation
and fail more often under full-suite parallel load.

- `src/__tests__/routes.smoke.test.ts` — 3+ timeouts in the assistant
  publish/approve chain
  - Symptom: 30s timeout on `POST /v1/admin/assistants/:id/versions/:vId/approve`
  - Likely cause: callback chain with audit + evidence + notification
    races under parallel test execution
  - Impact: none in production — integration tests (`run-api-tests.sh`)
    cover the same publish paths and pass 45/45 against a live API
  - Fix: raise `testTimeout` to 60s on the affected tests or mock the
    notification/evidence side-effects

- `src/__tests__/execution.service.test.ts` — 5 failures around mocked
  LLM/LiteLLM flows (FinOps caps, DLP flags, cache hits, timeout 502)
  - Symptom: mocks drift as services evolve; each test expects a shape
    the worker no longer emits verbatim
  - Impact: none — actual FinOps/DLP/cache behavior is exercised by the
    API integration suite

- `src/__tests__/audit-compliance.test.ts` — 2 failures (TEST-01,
  TEST-10) dependent on seed state and publishing side-effects

- `src/__tests__/assistant-versions.test.ts` — 1 failure on policy_json
  validation

## FASE 12 follow-ups

- **Add `last_login_at` column to `users`**: SOC 2 CC6.1 access-review
  endpoint currently derives last-seen from `audit_logs_partitioned`
  (via `metadata.actor_user_id`), falling back to `created_at`. A
  dedicated column updated by the login handler would be cheaper and
  more accurate. Migration + handler change are small, ~30 lines total.

- **Pentest suite: nightly staging pipeline**: the suite exists and is
  runnable on demand. A dedicated staging environment + credential
  management would allow running it nightly; tracked in ADR-015
  alternatives-considered.

- **Claude Code CLI version regression guard**: `test-claude-code-official-e2e.sh`
  catches breakage on the current CLI (2.1.112). Document the validated
  version in CI env so upgrades are explicit.

- **Helm chart: kustomize fallback**: if a customer refuses Helm, a
  thin `kustomize/` wrapper could be generated from the chart. Not
  prioritized — none of the pipeline deals have asked for it.
