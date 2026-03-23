# GovAI Platform — Current State

> **Gerado por auditoria** — todos os números derivados do repositório via `bash scripts/audit_project_state.sh`.
> Regenerar após cada sprint. Não editar manualmente.
>
> Última auditoria: 2026-03-22

---

## Migrations

| Métrica | Valor |
|---------|-------|
| Total de migrations | **42** |
| Intervalo | 011–053 (excluindo 050) |
| Fonte da verdade | `scripts/migrate.sh` |

## Testes

| Métrica | Valor |
|---------|-------|
| Total de arquivos de teste | **63** |
| Suíte padrão (sem DATABASE_URL) | **49 arquivos · 542 testes** |
| Suítes de integração (DATABASE_URL) | **14 arquivos** |
| Última execução padrão | `DATABASE_URL='' npx vitest run` → 542 pass · 2026-03-22 |

## Rotas Shield

| Métrica | Valor |
|---------|-------|
| Rotas em `shield.routes.ts` | **35** |

## Módulos implementados

| Módulo | Arquivo | Status |
|--------|---------|--------|
| Shield Core (detecção + risk engine + workflow) | `src/lib/shield.ts` | ✅ |
| Shield Collector Health + SLOs | `src/lib/shield-collector-health.ts` | ✅ |
| Shield Export (JSON/CSV) | `src/lib/shield-export.ts` | ✅ |
| Shield Métricas operacionais | `src/lib/shield-metrics.ts` | ✅ |
| Shield Collector (Microsoft OAuth) | `src/lib/shield-oauth-collector.ts` | ✅ |
| Shield Collector (Google Workspace) | `src/lib/shield-google-collector.ts` | ✅ |
| Shield Collector (Network/SWG/Proxy) | `src/lib/shield-network-collector.ts` | ✅ |
| Shield Risk Engine (5D scoring) | `src/lib/shield-risk-engine.ts` | ✅ |
| Shield Executive Report | `src/lib/shield-report.ts` | ✅ |
| Consultant Plane (cross-tenant auth) | `src/lib/consultant-auth.ts` | ✅ |
| Evidence Domain | `src/lib/evidence.ts` | ✅ |
| Shield Routes (35 endpoints) | `src/routes/shield.routes.ts` | ✅ |
| Consultant Routes | `src/routes/consultant.routes.ts` | ✅ |
| Admin UI | `admin-ui/package-lock.json` | ✅ |

## Build status

| Verificação | Status |
|-------------|--------|
| `npx tsc --noEmit` | ✅ clean |
| `admin-ui npm run build` | ✅ clean (Node ≥ 20) |
| `set_config(..., true)` em código Shield | ✅ 0 ocorrências |

## Sprint atual: S3 — Shield Enterprise Hardening

### S3A — Hardening implementado

- **Migration 053** — Colunas de health (success_count, failure_count, last_success_at, next_run_at, health_status) em todos os collectors; colunas de cobertura (sanctioned_count, unsanctioned_count, total_tools, coverage_ratio) em shield_posture_snapshots
- **Collector Health** — `recordCollectorSuccess`, `recordCollectorFailure`, `getCollectorHealth` com cálculo automático de health_status (healthy/degraded/error)
- **Export estruturado** — `exportFindingsAsJson`, `exportFindingsAsCsv`, `exportPostureAsJson` — todos RLS-enforced
- **Métricas operacionais** — `computeShieldMetrics` (collector success rates, finding freshness, processing backlog, coverage ratio)
- **Posture enrichment** — `generateExecutivePosture` agora persiste sanctioned_count, unsanctioned_count, total_tools, coverage_ratio

### S3B — Documentation Reset

- Volatile docs removidos (PROJECT_STATUS.md, PROJECT_STATE.md, TECHNICAL_REPORT.md, AUDIT_MANIFEST.md, CLAUDE_CODE_HANDOFF_2026-03-20.md, CHANGELOG_AUDIT_FIXES_2026-03-20.md)
- `scripts/audit_project_state.sh` criado — fonte da verdade para todos os números
- Docs canônicos regenerados: README.md, CURRENT_STATE.md, TEST_MANIFEST.md, OPERATIONS.md, PRODUCT_SURFACE.md, ADR-008

### S3C — Testes de integração

| Arquivo | Testes | Área |
|---------|--------|------|
| `shield.collector-health.test.ts` | T1–T6 | recordCollectorSuccess/Failure, health_status, getCollectorHealth, RLS |
| `shield.posture-history.test.ts` | T1–T6 | sanctioned_count, histórico ordenado, múltiplos snapshots, exportPostureAsJson, RLS |
| `shield.export.test.ts` | T1–T6 | exportFindingsAsJson, CSV header, RLS, computeShieldMetrics, GET /export/* |

## ADRs registrados

| ADR | Título |
|-----|--------|
| ADR-001 | No Streaming |
| ADR-002 | Modularization Roadmap |
| ADR-003 | Shield Core |
| ADR-004 | Shield Complete |
| ADR-006 | Shield S1-R Multisource |
| ADR-007 | Shield S2 Finding Workflow + Consultant Value |
| ADR-008 | Documentation Reset by Audit |

## Regras mandatórias (invariantes do codebase)

1. `set_config('app.current_org_id', $1, **false**)` — sempre `false` (session-local) em código Shield
2. `user_identifier_hash` = SHA-256(email) — nunca email plain em colunas críticas
3. `acceptRisk` requer `note` não-vazio; `dismissFinding` requer `reason` não-vazio
4. Tenant sem `consultant_assignment` → 403 nas rotas `/consultant/`
5. RLS sem mocks — testes de integração usam banco PostgreSQL real

## Como regenerar este documento

```bash
bash scripts/audit_project_state.sh
```
