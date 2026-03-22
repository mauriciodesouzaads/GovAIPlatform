# GovAI Platform — Test Manifest

## Contagem verificada

| Métrica | Valor |
|---------|-------|
| **Suíte padrão (sem DATABASE_URL)** | 542 testes · 49 arquivos |
| **Suíte de integração (DATABASE_URL)** | +29 garantias com banco real |
| **Total com banco** | 571+ (542 + 29 garantias confirmadas) |
| **Total de arquivos** | 54 (49 padrão + 5 integração) |
| **Status** | ✅ Suíte padrão: 542 passando |
| **Última execução** | 2026-03-22 |
| **Comando (suíte padrão)** | `npx vitest run` |
| **Comando (suíte completa)** | `DATABASE_URL=postgresql://... npx vitest run` |
| **Versão** | v1.1.1 (Sprint E-FIX / Pre-F) |

## Cobertura por sprint

| Sprint | Testes adicionados | Área coberta |
|--------|--------------------|--------------|
| Baseline | ~460 | Auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs |
| Sprint B | +10 | Policy snapshots, policy exceptions |
| Sprint C | +8 | Evidence domain (recordEvidence, linkEvidence, getEvidenceChain) |
| Sprint D | +8 | Catalog lifecycle (submit-review, catalog-review, suspend, archive) |
| Sprint E | +19 mock | Consultant Plane + compliance guarantees (mock pool) |
| Sprint E-FIX | rewrite | 19 mock → 19 DB real (movidos para integrationTestPatterns) |
| Sprint Pre-F | +1 | T6b: is_active=false excluído da query de auth |
| Sprint F | +10 DB real | Shield Core (normalização, rollups, findings, promote, RLS, endpoint) |
| **Suíte padrão** | **542** | |
| **Com banco (+garantias)** | **571+** | |

## Separação por tipo de execução

| Tipo | Arquivo | Requer DB | Testes |
|------|---------|-----------|--------|
| Lógica pura | `evidence.domain.test.ts` | Não | 8 |
| Lógica pura | `policy.snapshot.test.ts` | Não | 5 |
| Lógica pura | `catalog.lifecycle.test.ts` | Não | 8 |
| DB + API real | `compliance.guarantees.test.ts` | **Sim** | 11 (T1–T10 + T6b) |
| DB + API real | `consultant.plane.test.ts` | **Sim** | 8 |
| DB + API real | `shield.core.test.ts` | **Sim** | 10 (T1–T10) |
| DB real | `governance.flow.test.ts` | **Sim** | — |
| DB real | `governance.integration.test.ts` | **Sim** | — |
| DB real | `security.tenant-isolation.test.ts` | **Sim** | — |
| Unitário | demais 46 arquivos | Não | 521 |
| **Suíte padrão total** | **49 arquivos** | | **542** |

> Nota: `governance.flow`, `governance.integration` e `security.tenant-isolation` não têm
> contagem de testes exibida pois requerem infraestrutura completa (DB + Redis) para execução.

## Arquivos de teste (54 arquivos)

### Suíte padrão (49 arquivos — `npx vitest run`)

```
src/__tests__/
├── admin-me-telemetry.test.ts
├── api-key-rotation.test.ts
├── approvals.contract.test.ts
├── assistant-versions.test.ts
├── assistants.contract.test.ts
├── audit-compliance.test.ts
├── auth-oidc.test.ts
├── auth.reset.test.ts
├── b2b-pillars.test.ts
├── catalog.lifecycle.test.ts           ← Sprint D
├── compliance-report.test.ts
├── crypto-service.test.ts
├── dlp-extended.test.ts
├── dlp.test.ts
├── e2e-pg-presidio.test.ts
├── e2e.test.ts
├── evidence.domain.test.ts             ← Sprint C
├── execution.service.test.ts
├── expiration.worker.test.ts
├── governance.test.ts
├── input-validation.test.ts
├── integrity.test.ts
├── mcp.test.ts
├── monitoring.test.ts
├── observability.test.ts
├── oidc-decision-tree.test.ts
├── oidc.test.ts
├── oidc.unified.test.ts
├── opa-governance.test.ts
├── policy.exceptions.test.ts           ← Sprint B
├── policy.snapshot.test.ts             ← Sprint B
├── rag-dimension.test.ts
├── rag-extended.test.ts
├── rag.isolation.test.ts
├── rag.test.ts
├── rate-limit.test.ts
├── routes.smoke.test.ts
├── security.audit-crypto.test.ts
├── security.authorization.test.ts
├── security.crypto.test.ts
├── security.dlp-hitl.test.ts
├── security.dlp-leaks.test.ts
├── security.headers.test.ts
├── security.login-isolation.test.ts
├── security.mcp.test.ts
├── security.rbac.test.ts
├── security.rls.test.ts
├── security.sso.test.ts
└── session.model.test.ts
```

### Integração com banco (5 arquivos — requerem DATABASE_URL)

```
src/__tests__/
├── compliance.guarantees.test.ts       ← Sprint E-FIX + Pre-F (11 testes)
├── shield.core.test.ts                 ← Sprint F (banco real, 10 testes)
├── consultant.plane.test.ts            ← Sprint E-FIX (8 testes)
├── governance.flow.test.ts             ← integração completa
├── governance.integration.test.ts      ← integração completa
└── security.tenant-isolation.test.ts   ← integração completa
```

## Comando completo

```bash
# Suíte padrão (sem banco — 542 testes, 49 arquivos)
npx vitest run

# Suíte completa com banco (561+ testes)
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# Com coverage
npx vitest run --coverage

# Apenas garantias de compliance (banco real — 11 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose

# Apenas Consultant Plane (banco real — 8 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/consultant.plane.test.ts --reporter=verbose
```
