<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-03-28 04:43 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Current State

**Gerado em:** 2026-03-28 04:43 UTC

---

## Migrations

| Métrica | Valor |
|---------|-------|
| Total | **45** |
| Intervalo | 011–055 (excluindo 050) |
| Fonte | `scripts/migrate.sh` |

---

## Testes

| Métrica | Valor |
|---------|-------|
| Total de arquivos | **65** |
| Suíte padrão — arquivos | **50** |
| Suíte padrão — testes | **559** |
| Suíte integração — arquivos | **15** |

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

## ADRs (7)

- ADR-001-no-streaming.md
- ADR-002-modularization-roadmap.md
- ADR-003-shield-core.md
- ADR-004-shield-complete.md
- ADR-006-shield-s1r-multisource.md
- ADR-007-shield-s2-workflow-consultant.md
- ADR-008-documentation-reset-by-audit.md

---

## Limitações

- BullMQ workers: não implementados (coleta admin-triggered)
- SSE / browser extension: ver ADR-004
- Architect domain: Sprint A1 — demand_cases, problem_contracts, architecture_decision_sets, workflow_graphs, architect_work_items
