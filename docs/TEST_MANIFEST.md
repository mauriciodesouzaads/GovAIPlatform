# GovAI Platform — Test Manifest

## Contagem verificada

| Métrica | Valor |
|---------|-------|
| **Total de testes** | 542 |
| **Total de arquivos de teste** | 49 |
| **Status** | ✅ Todos passando |
| **Última execução** | 2026-03-22 |
| **Comando** | `npx vitest run` |
| **Versão** | v1.1.1 (commit 00e9a21) |

## Cobertura por sprint

| Sprint | Testes adicionados | Área coberta |
|--------|--------------------|--------------|
| Baseline | ~460 | Auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs |
| Sprint B | +10 | Policy snapshots, policy exceptions |
| Sprint C | +8 | Evidence domain (recordEvidence, linkEvidence, getEvidenceChain) |
| Sprint D | +8 (pending commit) | Catalog lifecycle (submit-review, catalog-review, suspend, archive) |
| **Total** | **542** | |

## Arquivos de teste (49 arquivos)

```
src/__tests__/
├── admin.auth.test.ts
├── admin.compliance.test.ts
├── admin.orgs.test.ts
├── api.gateway.test.ts
├── audit.worker.test.ts
├── byok.crypto.test.ts
├── catalog.lifecycle.test.ts       ← Sprint D
├── crypto.service.test.ts
├── dlp.engine.test.ts
├── e2e-pg-presidio.test.ts
├── evidence.domain.test.ts         ← Sprint C
├── execution.service.test.ts
├── finops.test.ts
├── governance.test.ts
├── hitl.approval.test.ts
├── identity.hardening.test.ts
├── knowledge.test.ts
├── lgpd.compliance.test.ts
├── mcp.test.ts
├── opa.governance.test.ts
├── policy.exceptions.test.ts       ← Sprint B
├── policy.snapshot.test.ts         ← Sprint B
├── rag.test.ts
├── rate.limiter.test.ts
├── redis.cache.test.ts
├── reports.test.ts
├── routes.coverage.test.ts
├── schemas.test.ts
├── security.hardening.test.ts
├── sre.metrics.test.ts
├── telemetry.worker.test.ts
└── ... (17 additional files)
```

## Comando completo

```bash
# Executar todos os testes
npx vitest run

# Com coverage
npx vitest run --coverage

# Com verbose (mostra cada teste)
npx vitest run --reporter=verbose
```
