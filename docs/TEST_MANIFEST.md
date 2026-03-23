# GovAI Platform — Test Manifest

> **Gerado por auditoria** — números derivados do repositório via `bash scripts/audit_project_state.sh`.
> Não editar manualmente. Regenerar após cada sprint.

## Contagem verificada

| Métrica | Valor |
|---------|-------|
| **Total de arquivos de teste** | 63 arquivos |
| **Suíte padrão (sem DATABASE_URL)** | 542 testes · 49 arquivos |
| **Suítes de integração (DATABASE_URL)** | 14 arquivos (requerem banco PostgreSQL real) |
| **Status suíte padrão** | ✅ 542 passando |
| **Última execução verificada** | 2026-03-22 |
| **Comando (suíte padrão)** | `DATABASE_URL='' npx vitest run` |
| **Comando (suíte integração)** | `DATABASE_URL=postgresql://... npx vitest run` |
| **Versão** | v1.5.0 (Sprint Shield S3) |

## Cobertura por sprint

| Sprint | Arquivos integração | Área coberta |
|--------|---------------------|--------------|
| Baseline | — | Auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs (542 padrão) |
| Sprint B | — | Policy snapshots, policy exceptions |
| Sprint C | — | Evidence domain |
| Sprint D | — | Catalog lifecycle |
| Sprint E / E-FIX | `compliance.guarantees.test.ts`, `consultant.plane.test.ts` | Consultant Plane + compliance guarantees |
| Sprint F / F2a | `governance.flow.test.ts`, `governance.integration.test.ts`, `security.tenant-isolation.test.ts`, `shield.core.test.ts`, `shield.collector.test.ts`, `shield.risk-engine.test.ts` | Shield Core + Risk Engine |
| Sprint S1-R | `shield.network-collector.test.ts`, `shield.multisource-resolution.test.ts` | Network collector, multisource correlation |
| Sprint S2 | `shield.workflow.test.ts` | Finding workflow, consultant Shield views, posture unresolved_critical |
| **Sprint S3** | **`shield.collector-health.test.ts`, `shield.posture-history.test.ts`, `shield.export.test.ts`** | **Collector health SLOs, posture history, export JSON/CSV, métricas** |

## Suítes de integração (14 arquivos — requerem DATABASE_URL)

```
src/__tests__/
├── governance.flow.test.ts                ← integração completa
├── governance.integration.test.ts         ← integração completa
├── security.tenant-isolation.test.ts      ← isolamento multi-tenant
├── compliance.guarantees.test.ts          ← Sprint E-FIX (11 testes)
├── consultant.plane.test.ts               ← Sprint E (8 testes)
├── shield.core.test.ts                    ← Sprint F (23 testes T1–T13, T20–T23)
├── shield.collector.test.ts               ← Sprint F (8 testes T1–T8)
├── shield.risk-engine.test.ts             ← Sprint F2a (12 testes T1–T11)
├── shield.network-collector.test.ts       ← Sprint S1-R (6 testes T1–T6)
├── shield.multisource-resolution.test.ts  ← Sprint S1-R (13 testes T1–T13)
├── shield.workflow.test.ts                ← Sprint S2 (17 testes T1–T17)
├── shield.collector-health.test.ts        ← Sprint S3 (6 testes T1–T6)
├── shield.posture-history.test.ts         ← Sprint S3 (6 testes T1–T6)
└── shield.export.test.ts                  ← Sprint S3 (6 testes T1–T6)
```

## Suíte padrão (49 arquivos — `DATABASE_URL='' npx vitest run`)

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
├── catalog.lifecycle.test.ts
├── compliance-report.test.ts
├── crypto-service.test.ts
├── dlp-extended.test.ts
├── dlp.test.ts
├── e2e-pg-presidio.test.ts
├── e2e.test.ts
├── evidence.domain.test.ts
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
├── policy.exceptions.test.ts
├── policy.snapshot.test.ts
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

## Tabelas Shield (13 tabelas — migrations 047–053)

| Tabela | Migration | Descrição |
|--------|-----------|-----------|
| `shield_tools` | 047 | Dicionário enriquecido de ferramentas detectadas |
| `shield_observations_raw` | 047 | Observações brutas de uso (user_identifier_hash SHA-256) |
| `shield_rollups` | 047 | Rollup diário por ferramenta + org |
| `shield_findings` | 047 | Findings de risco (workflow: open→promoted/resolved) |
| `shield_executive_reports` | 048 | Relatórios executivos persistidos |
| `shield_oauth_collectors` | 048 | Coletores Microsoft Graph OAuth |
| `shield_oauth_grants` | 048 | Grants OAuth coletados |
| `shield_google_collectors` | 049 | Coletores Google Workspace Admin SDK |
| `shield_google_tokens` | 049 | Tokens Google (criptografados, hash para dedup) |
| `shield_finding_actions` | 049 | Log imutável de ações em findings |
| `shield_posture_snapshots` | 049 | Snapshots executivos de postura de risco |
| `shield_network_collectors` | 051 | Coletores Network/SWG/Proxy |
| `shield_network_observations` | 051 | Observações de tráfego de rede |

*Migrations 052 e 053 adicionam colunas a tabelas existentes (não criam tabelas novas).*

## Comandos de referência

```bash
# Suíte padrão (sem banco)
DATABASE_URL='' npx vitest run

# Suíte de integração completa (banco real)
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# Arquivo individual (exemplo)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.export.test.ts --reporter=verbose

# Regenerar este manifesto
bash scripts/audit_project_state.sh
```
