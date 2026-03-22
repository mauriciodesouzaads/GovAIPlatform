# GovAI Platform — Test Manifest

## Contagem verificada

| Métrica | Valor |
|---------|-------|
| **Total de testes (sem banco)** | 542 |
| **Total de testes (com banco)** | 560+ (inclui 18 garantias com DB real) |
| **Total de arquivos de teste** | 51 |
| **Status** | ✅ Todos passando (sem banco: 542; com banco: 560+) |
| **Última execução** | 2026-03-22 |
| **Comando (sem banco)** | `npx vitest run` |
| **Comando (com banco)** | `DATABASE_URL=postgresql://... npx vitest run` |
| **Versão** | v1.1.1 (Sprint E-FIX) |

## Cobertura por sprint

| Sprint | Testes adicionados | Área coberta |
|--------|--------------------|--------------|
| Baseline | ~460 | Auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs |
| Sprint B | +10 | Policy snapshots, policy exceptions |
| Sprint C | +8 | Evidence domain (recordEvidence, linkEvidence, getEvidenceChain) |
| Sprint D | +8 | Catalog lifecycle (submit-review, catalog-review, suspend, archive) |
| Sprint E | +19 | Consultant Plane (mock) + compliance guarantees (mock) |
| Sprint E-FIX | rewrite | Garantias migradas para banco real (−mock, +DB real) |
| **Total (sem banco)** | **542** | |
| **Total (com banco)** | **560+** | |

## Separação de testes por tipo de execução

| Tipo | Arquivo | Requer DB | Testes |
|------|---------|-----------|--------|
| Unitário / Lógica pura | `evidence.domain.test.ts` | Não | 8 |
| Unitário / Lógica pura | `policy.snapshot.test.ts` | Não | 5 |
| Unitário / Lógica pura | `catalog.lifecycle.test.ts` | Não | 8 |
| Integração (banco real) | `compliance.guarantees.test.ts` | **Sim** | 10 |
| Integração (banco real) | `consultant.plane.test.ts` | **Sim** | 8 |
| Integração (banco real) | `governance.flow.test.ts` | **Sim** | — |
| Integração (banco real) | `governance.integration.test.ts` | **Sim** | — |
| Integração (banco real) | `security.tenant-isolation.test.ts` | **Sim** | — |
| Todos os demais | `*.test.ts` (44 arquivos) | Não | 521 |

## Arquivos de teste (51 arquivos)

```
src/__tests__/
├── admin.auth.test.ts
├── admin.compliance.test.ts
├── admin.orgs.test.ts
├── api.gateway.test.ts
├── audit.worker.test.ts
├── byok.crypto.test.ts
├── catalog.lifecycle.test.ts           ← Sprint D
├── compliance.guarantees.test.ts       ← Sprint E / E-FIX (banco real)
├── consultant.plane.test.ts            ← Sprint E / E-FIX (banco real)
├── crypto.service.test.ts
├── dlp.engine.test.ts
├── e2e-pg-presidio.test.ts
├── evidence.domain.test.ts             ← Sprint C
├── execution.service.test.ts
├── finops.test.ts
├── governance.test.ts
├── hitl.approval.test.ts
├── identity.hardening.test.ts
├── knowledge.test.ts
├── lgpd.compliance.test.ts
├── mcp.test.ts
├── opa.governance.test.ts
├── policy.exceptions.test.ts           ← Sprint B
├── policy.snapshot.test.ts             ← Sprint B
├── rag.test.ts
├── rate.limiter.test.ts
├── redis.cache.test.ts
├── reports.test.ts
├── routes.coverage.test.ts
├── schemas.test.ts
├── security.hardening.test.ts
├── sre.metrics.test.ts
├── telemetry.worker.test.ts
└── ... (18 additional files)
```

## Comando completo

```bash
# Executar todos os testes (sem banco — 542 testes)
npx vitest run

# Com banco (560+ testes, inclui garantias reais)
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# Com coverage
npx vitest run --coverage

# Com verbose (mostra cada teste)
npx vitest run --reporter=verbose

# Apenas garantias de compliance (banco real)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose

# Apenas Consultant Plane (banco real)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/consultant.plane.test.ts --reporter=verbose
```
