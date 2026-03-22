# ADR-002 — Modularização Progressiva do Backend

## Status: Accepted

## Data: 2026-03-22

## Contexto

`admin.routes.ts` (913 linhas) e `assistants.routes.ts` (801 linhas) concentram responsabilidades que deveriam estar em módulos de domínio separados. Uma refatoração big-bang seria arriscada dado o volume de testes e a complexidade dos fluxos de governança.

O projeto passou por 4 sprints (A–D) que adicionaram funcionalidades sem oportunidade de reestruturação arquitetural. O resultado são dois arquivos de rota oversized que agrupam domínios distintos:

| Arquivo | Linhas | Domínios misturados |
|---------|--------|---------------------|
| `admin.routes.ts` | 913 | Auth, orgs, API keys, stats, audit logs, compliance, policy exceptions, evidence |
| `assistants.routes.ts` | 801 | CRUD assistants, versioning, lifecycle catalog, runtime bindings, RAG/KB |
| `platform.routes.ts` | 55 | Platform admin views (já extraído — Sprint B) |

## Decisão

Adotar extração progressiva por domínio, sem refatoração big-bang. Cada nova sprint extrai responsabilidades ao registrar novas rotas, reduzindo os arquivos oversized gradualmente.

### Fase 1 (concluída — Sprint B/D)

Extrações já realizadas:
- `platform.routes.ts` — rotas do control-plane de plataforma (`platform_admin`)
- `consultant.routes.ts` — rotas do Consultant Plane (Sprint E, planejado)

### Fase 2 (após Sprint E)

Extrair de `assistants.routes.ts`:
- `catalog.routes.ts` — `GET /catalog`, lifecycle transitions (submit-for-review, catalog-review, suspend, archive), runtime-bindings CRUD

Extrair de `admin.routes.ts`:
- `policy.routes.ts` — policy exceptions (`POST/PUT/DELETE /v1/admin/policy-exceptions`)
- `compliance.routes.ts` — relatórios de compliance, trilha LGPD, exportações PDF/CSV

### Fase 3 (após Sprint F)

Extrair de `admin.routes.ts`:
- `evidence.routes.ts` — `GET /v1/admin/evidence` (consulta de evidências com filtros)
- `reporting.routes.ts` — consolidar `reports.routes.ts` + exportações de audit

Extrair de `assistants.routes.ts`:
- `versions.routes.ts` — versionamento de assistentes (criar versão, aprovar/publicar)

### Meta pós-Fase 3

| Arquivo | Linhas estimadas |
|---------|-----------------|
| `admin.routes.ts` | ~300 (auth, orgs, users, API keys, stats) |
| `assistants.routes.ts` | ~200 (CRUD básico, RAG/KB) |
| `catalog.routes.ts` | ~250 (lifecycle + runtime bindings) |
| `policy.routes.ts` | ~150 (exceptions + snapshots) |
| `compliance.routes.ts` | ~200 (reports + LGPD) |
| `evidence.routes.ts` | ~80 (evidence queries) |
| `platform.routes.ts` | ~55 (já existente) |

## Consequências

**Positivas:**
- Sem risco de refatoração big-bang durante sprints de features
- Cada extração é pequena, testável e reversível
- `admin.routes.ts` e `assistants.routes.ts` encolhem naturalmente
- Arquivos de rota menores → easier code review e onboarding

**Negativas:**
- Módulos de domínio ficam geograficamente dispersos até Fase 3
- Sub-plugins Fastify (`app.register`) aumentam levemente a complexidade de inicialização

## Alternativas Rejeitadas

1. **Refatoração imediata (big-bang)**: alto risco de regressão dado o tamanho atual (1.714 linhas combinadas); descartada.
2. **Manter como está**: dívida técnica acumularia, tornando futuras extrações mais custosas; descartada.
3. **Monorepo por domínio**: overhead operacional excessivo para o estágio atual do projeto; descartada.

## Referências

- ADR-001: `docs/ADR-001-no-streaming.md` — decisão sobre SSE/streaming
- Sprint B commit: `dcad793` — extração de `platform.routes.ts`
- Sprint D commit: pending — adição de lifecycle catalog em `assistants.routes.ts`
