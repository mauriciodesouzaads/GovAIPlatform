<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-04-05 15:32 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Test Manifest

**Gerado em:** 2026-04-05 15:32 UTC

---

## Contagem

| Métrica | Valor |
|---------|-------|
| Total de arquivos de teste | **67** |
| Suíte padrão — arquivos | **51** |
| Suíte padrão — testes | **(não executado)** |
| Suíte integração — arquivos | **16** |

---

## Comandos

```bash
# Suíte padrão (sem banco)
DATABASE_URL='' npx vitest run

# Suíte integração (requer PostgreSQL)
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname npx vitest run

# Migrations clean test
bash scripts/test-migrations-clean.sh
```

---

## Arquivos de integração (16 — requerem DATABASE_URL)

- `architect.delegation.test.ts.`
- `architect.domain.test.ts.`
- `compliance.guarantees.test.ts.`
- `consultant.plane.test.ts.`
- `governance.flow.test.ts.`
- `governance.integration.test.ts.`
- `security.tenant-isolation.test.ts.`
- `shield.collector-health.test.ts.`
- `shield.collector.test.ts.`
- `shield.core.test.ts.`
- `shield.export.test.ts.`
- `shield.multisource-resolution.test.ts.`
- `shield.network-collector.test.ts.`
- `shield.posture-history.test.ts.`
- `shield.risk-engine.test.ts.`
- `shield.workflow.test.ts.`

---

## Suíte padrão

51 arquivos em `src/__tests__/` não listados acima.
Inclui: auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs, policy, evidence, catalog,
Shield unit tests, risk engine unit tests.

Não requer serviços externos. Roda em CI puro.
