<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-04-06 20:59 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Current State

**Gerado em:** 2026-04-06 20:59 UTC

---

## Migrations

| Métrica | Valor |
|---------|-------|
| Total | **48** |
| Intervalo | 011–058 (excluindo 050) |
| Fonte | `scripts/migrate.sh` |

---

## Testes

| Métrica | Valor |
|---------|-------|
| Total de arquivos | **67** |
| Suíte padrão — arquivos | **51** |
| Suíte padrão — testes | **574** |
| Suíte integração — arquivos | **16** |

Comando: `DATABASE_URL='' npx vitest run`

---

## Domínios

| Domínio | Status |
|---------|--------|
| Gateway Core | ✓ |
| Policy Snapshots | ✓ |
| Evidence | ✓ |
| Catalog | ✓ |
| Consultant Plane | ✓ |
| Shield | ✓ |
| Architect | ✓ |

---

## Shield API Routes

| Módulo | Rotas |
|--------|-------|
| Admin (`/v1/admin/shield/*`) | 32 |
| Consultant (`/v1/consultant/tenants/*/shield/*`) | 3 |
| **Total** | **35** |

---

## Build

| Check | Status |
|-------|--------|
| tsc --noEmit | ✓ clean |
| Admin UI lockfile | ✓ |

---

## ADRs (8)

- ADR-001-no-streaming.md
- ADR-002-modularization-roadmap.md
- ADR-003-shield-core.md
- ADR-004-shield-complete.md
- ADR-006-shield-s1r-multisource.md
- ADR-007-shield-s2-workflow-consultant.md
- ADR-008-documentation-reset-by-audit.md
- ADR-009-architect-domain.md

---

## Limitações

- BullMQ Shield workers: implementados — 5 cron jobs (shield.worker.ts + shield-schedule.job.ts): generate-findings, dedupe-findings, posture-snapshot, collect-oauth, collect-google
- SSE / browser extension: não implementado — ver ADR-004
- CASB integration: não implementada
- Agno runtime: stub only (AGNO_ENABLED=false) — sem adapter real
- Claude Code adapter: enum only — sem adapter implementado
- Architect domain: Sprints A1–A5 — demand_cases, problem_contracts (discovery stateful + confidence scoring), architecture_decision_sets, workflow_graphs, architect_work_items, architect-delegation (dispatchWorkItem, internal_rag adapter, human adapter, agno stub), generateArchitectDocument via LiteLLM, generateCaseSummary, SELECT FOR UPDATE SKIP LOCKED concurrency, ADR-009 with 8 formal decisions
