# GovAI Platform — Test Manifest

## Contagem verificada

| Métrica | Valor |
|---------|-------|
| **Suíte padrão (sem DATABASE_URL)** | 542 testes · 49 arquivos |
| **Suíte de integração (DATABASE_URL)** | +55 garantias (62 testes DB real confirmados) |
| **Total de arquivos** | 59 (49 padrão + 10 integração) |
| **Status** | ✅ Suíte padrão: 542 passando (DATABASE_URL='' npx vitest run) |
| **Última execução** | 2026-03-22 |
| **Comando (suíte padrão)** | `DATABASE_URL='' npx vitest run` |
| **Comando (suíte completa)** | `DATABASE_URL=postgresql://... npx vitest run` |
| **Versão** | v1.3.0 (Sprint Shield S1-R) |

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
| Sprint F2a | +12 DB real | Risk engine (scoreVersion, recommendedAction, category) — movido para integrationTestPatterns em CI fix #86 |
| **Sprint Shield Complete** | **+43 integração** | Finding workflow, Google collector, posture snapshot, rotas novas |
| **Sprint S1-R** | **+19 integração** | Network collector, multisource correlation, dedupe, catalog sync, owner candidate |
| **Suíte padrão** | **542** | |
| **Com banco (+garantias)** | **604** (542 + 62 DB integration confirmados) | |

## Separação por tipo de execução

| Tipo | Arquivo | Requer DB | Testes |
|------|---------|-----------|--------|
| Lógica pura | `evidence.domain.test.ts` | Não | 8 |
| Lógica pura | `policy.snapshot.test.ts` | Não | 5 |
| Lógica pura | `catalog.lifecycle.test.ts` | Não | 8 |
| DB + API real | `compliance.guarantees.test.ts` | **Sim** | 11 (T1–T10 + T6b) |
| DB + API real | `consultant.plane.test.ts` | **Sim** | 8 |
| DB + API real | `shield.core.test.ts` | **Sim** | 23 (T1–T13, T20–T23) |
| DB + API real | `shield.collector.test.ts` | **Sim** | 8 (T1–T8 incl. Google) |
| DB real | `shield.risk-engine.test.ts` | **Sim** | 12 (T1–T11, requer DATABASE_URL) |
| DB + API real | `shield.network-collector.test.ts` | **Sim** | 6 (T1–T2 pura, T3–T6 DB real) |
| DB + API real | `shield.multisource-resolution.test.ts` | **Sim** | 13 (T1–T2 pura, T3–T13 DB + rota real) |
| DB real | `governance.flow.test.ts` | **Sim** | — |
| DB real | `governance.integration.test.ts` | **Sim** | — |
| DB real | `security.tenant-isolation.test.ts` | **Sim** | — |
| Unitário | demais 46 arquivos | Não | 542 |
| **Suíte padrão total** | **49 arquivos** | | **542** |

> Nota: `governance.flow`, `governance.integration` e `security.tenant-isolation` não têm
> contagem de testes exibida pois requerem infraestrutura completa (DB + Redis) para execução.

## Arquivos de teste (57 arquivos)

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

### Integração com banco (10 arquivos — requerem DATABASE_URL)

```
src/__tests__/
├── compliance.guarantees.test.ts          ← Sprint E-FIX + Pre-F (11 testes)
├── shield.core.test.ts                    ← Sprint Shield Complete (23 testes T1–T13, T20–T23)
├── shield.collector.test.ts               ← Sprint Shield Complete (8 testes T1–T8)
├── shield.risk-engine.test.ts             ← Sprint F2a / CI fix #86 (12 testes T1–T11)
├── shield.network-collector.test.ts       ← Sprint S1-R (6 testes T1–T6)
├── shield.multisource-resolution.test.ts  ← Sprint S1-R (13 testes T1–T13)
├── consultant.plane.test.ts               ← Sprint E-FIX (8 testes)
├── governance.flow.test.ts                ← integração completa
├── governance.integration.test.ts         ← integração completa
└── security.tenant-isolation.test.ts      ← integração completa
```

## Tabelas Shield (11 tabelas — migration 047–049)

| Tabela | Migration | Descrição |
|--------|-----------|-----------|
| `shield_tools` | 047 | Dicionário enriquecido de ferramentas detectadas |
| `shield_observations_raw` | 047 | Observações brutas de uso (user_identifier_hash) |
| `shield_rollups` | 047 | Rollup diário por ferramenta + org |
| `shield_findings` | 047 | Findings de risco (workflow: open→promoted/resolved) |
| `shield_executive_reports` | 048 | Relatórios executivos persistidos |
| `shield_oauth_collectors` | 048 | Coletores Microsoft Graph OAuth |
| `shield_oauth_grants` | 048 | Grants OAuth coletados |
| `shield_google_collectors` | 049 | Coletores Google Workspace Admin SDK |
| `shield_google_tokens` | 049 | Tokens Google (criptografados, hash para dedup) |
| `shield_finding_actions` | 049 | Log imutável de ações em findings |
| `shield_posture_snapshots` | 049 | Snapshots executivos de postura de risco |

## Comando completo

```bash
# Suíte padrão (sem banco — 542 testes, 49 arquivos)
npx vitest run

# Suíte completa com banco (593+ testes)
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# Com coverage
npx vitest run --coverage

# Shield Core (banco real — 23 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.core.test.ts --reporter=verbose

# Shield Collector (banco real — 8 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.collector.test.ts --reporter=verbose

# Apenas garantias de compliance (banco real — 11 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose
```
