# ADR-003 — Shield Core / Detection Foundation

**Data:** 2026-03-22
**Status:** Accepted
**Sprint:** F — Shield Core

---

## Contexto

O GovAI Platform necessita de um plano de detecção de uso shadow AI — ferramentas de IA
utilizadas em organizações sem aprovação formal do time de governança. Este ADR documenta
as decisões de design da Sprint F, que entrega o núcleo desse domínio.

---

## O que a Sprint F entrega

| Componente | Descrição |
|-----------|-----------|
| `047_shield_core.sql` | Schema: `shield_tools`, `shield_observations_raw`, `shield_rollups`, `shield_findings` com RLS |
| `src/lib/shield.ts` | Normalização de nomes, hash de identidade, ingestão, processamento, findings, promoção |
| `src/routes/shield.routes.ts` | Rotas admin: observations, process, findings/generate, findings/list, acknowledge, promote |
| `src/__tests__/shield.core.test.ts` | 10 testes T1–T10 com PostgreSQL real (sem mocks) |
| `docs/ADR-003-shield-core.md` | Este documento |

### Decisões de design

**1. `set_config('app.current_org_id', $1, false)` — session-level, não transaction-local**

Usar `false` (não `true`) garante que o contexto RLS persiste na conexão
pelo tempo necessário para operações multi-step. O caller sempre limpa
no `finally` via `set_config('app.current_org_id', '', false)`.

**2. `UNIQUE(org_id, tool_name_normalized, period_start)` — sem `tool_id`**

`tool_id` pode ser `NULL` até que o match seja feito. `NULL != NULL` em
índices UNIQUE causaria duplicatas silenciosas. A chave de negócio do rollup
é `(org_id, tool_name_normalized, period_start)`.

**3. `user_identifier_hash` — nunca e-mail cru**

Identidades de usuário são armazenadas apenas como SHA-256. O campo
`user_identifier_hash` é derivado de qualquer identificador (e-mail, username).
O e-mail cru nunca é armazenado como campo principal de identidade.

**4. Findings não são imutáveis nesta sprint**

Findings evoluem de estado (`open → acknowledged → promoted/resolved/dismissed`).
A imutabilidade auditável é provida pelo `evidence_records` linkado à promoção.

**5. Promoção gera evidência integrada**

`promoteShieldFindingToCatalog` sempre:
- Cria um `assistant` com `lifecycle_state = 'draft'` no catálogo
- Marca o finding como `promoted`
- Gera `evidence_record` com `event_type = 'SHIELD_FINDING_PROMOTED'`
- Linka o evidence ao finding via `evidence_links`

---

## O que a Sprint F NÃO entrega

| Item | Motivo / Sprint futura |
|------|----------------------|
| Collectors corporativos reais | M365, Google Workspace, DNS, browser extension requerem integrações OAuth/API externas — Sprint G |
| Workers de processamento assíncrono | BullMQ job para `processShieldObservations` periódico — Sprint G |
| Regras de severidade complexas | Modelo de risco baseado em comportamento histórico, anomalias, horário — Sprint H |
| UI de gestão de findings | Dashboard admin no Next.js — Sprint G |
| Integração com alertas de consultores | `consultant_alerts` criados a partir de findings — Sprint G |
| Enriquecimento de ferramentas (vendor, categoria) | Dicionário curado / integração com CAIQ — Sprint H |
| Exportação de relatório de shadow AI | PDF/CSV para DPO — Sprint H |

---

## Impacto em schema

- **Nova migration**: `047_shield_core.sql` — 4 novas tabelas
- **Migrations anteriores não foram alteradas**
- **Total de migrations**: 37 (011–047)

---

## Impacto em testes

- `shield.core.test.ts` adicionado a `integrationTestPatterns` em `vitest.config.ts`
- Suíte padrão (sem banco): **542 testes** (inalterado)
- Suíte com banco: **542 + 29 garantias** (19 anteriores + 10 Shield)
