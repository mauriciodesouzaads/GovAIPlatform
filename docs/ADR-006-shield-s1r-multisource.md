# ADR-006 — Shield S1-R / Multisource Resolution + Baseline Sanity

**Data:** 2026-03-22
**Status:** Accepted
**Sprint:** Shield S1-R (builds on F + F2a + Shield Complete)

---

## Contexto

As sprints anteriores entregaram Shield Core (F), Risk Engine + Microsoft OAuth + Executive Report (F2a), e o workflow completo de findings com Google collector e posture snapshots (Shield Complete). A Sprint S1-R fecha a lacuna de correlação multissinal: como sinais de fontes diferentes para a mesma ferramenta são unificados em um finding coerente, sem duplicatas.

---

## O que a Sprint S1-R entrega

| Componente | Descrição |
|-----------|-----------|
| `051_shield_multisource_resolution.sql` | Adiciona `source_types JSONB` e `correlation_count INTEGER` em `shield_findings`; cria `shield_network_collectors` e `shield_network_events_raw` |
| `src/lib/shield-network-collector.ts` | Coletor proxy/SWG/network: `storeNetworkCollector`, `normalizeNetworkSignal`, `ingestNetworkBatch` |
| `src/lib/shield.ts` (adições) | `mergeOrUpdateFinding`, `dedupeFindings`, `syncShieldToolsWithCatalog`, `computeOwnerCandidate` |
| `src/routes/shield.routes.ts` (adições) | `POST /network/collectors`, `POST /network/collectors/:id/ingest`, `POST /dedupe`, `POST /sync-catalog` |
| `src/__tests__/shield.network-collector.test.ts` | 6 testes T1–T6 (T1–T2 lógica pura, T3–T6 banco real) |
| `src/__tests__/shield.multisource-resolution.test.ts` | 13 testes T1–T13 (T1–T2 lógica pura, T3–T13 banco real + rotas reais) |
| `docs/ADR-006-shield-s1r-multisource.md` | Este documento |
| `admin-ui/package-lock.json` (atualizado) | Lockfile regenerado com Node 20 — `npm ci` e `npm run build` reproduzíveis |

### Decisões de design

**1. `mergeOrUpdateFinding` — chave de deduplicação determinística**

A chave de negócio para deduplicação é `(org_id, tool_name_normalized, status IN ('open','acknowledged'))`. Uma segunda fonte não cria novo finding — chama `mergeOrUpdateFinding` que:
- incrementa `correlation_count` apenas quando a fonte é nova (não duplicada)
- adiciona a fonte ao array `source_types` (sem duplicatas via `Array.from(new Set(...))`)
- eleva `risk_score` para o máximo entre o existente e o novo
- acumula `observation_count` e maximiza `unique_users`

**2. `dedupeFindings` — tratamento defensivo de race conditions**

Caso improvável mas defensivo: se dois findings foram criados para a mesma ferramenta (race condition), o mais antigo é mantido, os counts/sources dos duplicados são merged nele, e os duplicados são fechados como `resolved` (nunca deletados — audit trail preservado).

**3. `syncShieldToolsWithCatalog` — approval_status do Catálogo real**

Nenhum valor de `isSanctioned` é hardcoded. O estado real vem dos `assistants` no Catálogo:
- `lifecycle_state = 'published'` → `approval_status = 'approved'`, `sanctioned = true`
- `lifecycle_state IN ('deprecated','archived','suspended')` → `approval_status = 'restricted'`, `sanctioned = false`
- Demais estados (draft, under_review) → sem alteração

**4. `computeOwnerCandidate` — heurística mínima sem overengineering**

O user_identifier_hash mais frequente nas observações de uma ferramenta é o owner candidate, se tiver ≥ 3 observações. Se houver `department_hint`, ele é incluído na fonte do candidato. Retorna `null` quando não há base mínima. É um **candidate**, não uma verdade.

**5. `sourceType = 'network'` — consistente com CHECK constraint**

O network collector usa `sourceType = 'network'`, que é um valor válido no CHECK constraint de `shield_observations_raw.source_type`. Não foram inventados valores fora do domínio.

**6. Admin UI — Node.js >= 20 obrigatório**

`@tailwindcss/oxide@4.2.2` requer Node.js >= 20 (`"engines": { "node": ">= 20" }`). O package-lock.json foi regenerado com Node 20.20.1 para incluir o binding nativo `@tailwindcss/oxide-darwin-arm64` e garantir `npm ci && npm run build` reproduzíveis no CI (que usa Node 20).

**Diagnóstico documentado**: com Node 18, `npm ci` instala o pacote mas não resolve o optional binding nativo, causando `Cannot find native binding`. Com Node 20, a resolução funciona corretamente.

---

## O que a Sprint S1-R NÃO entrega

| Item | Motivo / Sprint futura |
|------|------------------------|
| Browser/endpoint collector | Requer extensão de browser ou agente no endpoint — Sprint G |
| DNS/proxy tap completo | Dependência de infrastructure tap no nível de rede — Sprint G |
| API egress collector completo | Requer interceptação de API gateway — Sprint G |
| CASB / SSE completo | Arquitetura de data plane separada — fora do escopo |
| Worker assíncrono de coleta | BullMQ job periódico — Sprint G; coleta ainda admin-triggered |
| ML/IA para owner resolution | Heurística de frequência implementada; ML fica para Sprint H |
| Correlação com eventos externos (SIEM) | Requer integração com Splunk/Elastic — Sprint H |

---

## Fontes reais suportadas após S1-R

| Fonte | Protocolo/API | Tabela de ingestão | Status |
|-------|---------------|-------------------|--------|
| Manual (admin input) | REST API `POST /observations` | `shield_observations_raw` | Ativo desde Sprint F |
| Microsoft Graph OAuth | `v1.0/oauth2PermissionGrants` | `shield_oauth_collectors` | Ativo desde F2a |
| Google Workspace Admin SDK | `admin/reports/v1/activity` | `shield_google_collectors` | Ativo desde Shield Complete |
| Network/SWG/Proxy | REST API `POST /network/collectors/:id/ingest` | `shield_network_events_raw` | Ativo desde S1-R |

O diferencial desta plataforma é: **governança + evidência + catalog promotion + consultoria operacional + correlação multissinal**, não paridade com SSE/CASB enterprise completo.

---

## Impacto em schema

- **Nova migration**: `051_shield_multisource_resolution.sql`
- **Tabelas novas**: `shield_network_collectors`, `shield_network_events_raw` (13 tabelas Shield total)
- **shield_findings enriquecido**: `source_types JSONB`, `correlation_count INTEGER`
- **Total de migrations**: 40 (011–051, excluindo 050)

---

## Impacto em testes

- `shield.network-collector.test.ts`: 6 testes (T1–T2 lógica pura, T3–T6 banco real)
- `shield.multisource-resolution.test.ts`: 13 testes (T1–T2 lógica pura, T3–T13 banco real + rotas)
- Suíte padrão: **542 testes · 49 arquivos** (inalterado — novos arquivos em integrationTestPatterns)
- Suíte DB integration: +19 testes adicionais (shield.network-collector + shield.multisource)

---

## Próxima sprint sugerida (Sprint G — Collectors + Workers)

- Collector browser extension (agent-based)
- Worker BullMQ para coleta periódica (admin-triggered → worker-triggered)
- DNS/proxy collector com packet tap mínimo
- Alertas de consultant gerados de findings (`consultant_alerts`)
- Dashboard UI de findings no Admin UI Next.js
