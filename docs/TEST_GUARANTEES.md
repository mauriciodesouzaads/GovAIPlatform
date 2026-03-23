# GovAI Platform — Matriz de Garantias Auditáveis

Este documento lista garantias de segurança e conformidade verificáveis via testes automatizados.
Auditores externos podem executar `DATABASE_URL=postgresql://... npx vitest run --reporter=verbose` para validar cada garantia.

> **Sprint E-FIX**: todos os testes de garantia foram reescritos para usar PostgreSQL real.
> Sem mocks de trigger, sem mocks de pool. Ver `vitest.config.ts` para exclusão automática quando `DATABASE_URL` não está definido.

---

## Garantias de Imutabilidade

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `audit_logs_partitioned` é imutável | `compliance.guarantees.test.ts` | T1 | Trigger BEFORE UPDATE/DELETE (banco real) | DB real |
| `policy_snapshots` é imutável | `compliance.guarantees.test.ts` | T2 | Trigger BEFORE UPDATE/DELETE (banco real) | DB real |
| `evidence_records` é imutável | `compliance.guarantees.test.ts` | T3 | Trigger BEFORE UPDATE/DELETE (banco real) | DB real |
| `consultant_audit_log` é imutável | `compliance.guarantees.test.ts` | T4 | Trigger BEFORE UPDATE/DELETE (banco real) | DB real |
| `consultant_audit_log` UPDATE dispara trigger | `consultant.plane.test.ts` | T7 | Trigger BEFORE UPDATE/DELETE (banco real) | DB real |

---

## Garantias de Integridade Criptográfica

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `integrity_hash` = SHA-256(orgId\|category\|eventType\|metadata) | `compliance.guarantees.test.ts` | T5 | Algoritmo em `evidence.ts` | Lógica pura |
| `integrity_hash` é determinístico (mesmo input → mesmo hash) | `compliance.guarantees.test.ts` | T5 | SHA-256 puro (sem salt) | Lógica pura |
| Hashes distintos para metadados distintos | `compliance.guarantees.test.ts` | T5 | Resistência a colisão SHA-256 | Lógica pura |
| Nenhum `evidence_record` com `integrity_hash IS NULL` | `compliance.guarantees.test.ts` | T9 | SELECT COUNT(*) contra banco real | DB real |
| `policy_hash` = SHA-256(JSON(policyJson)) | `policy.snapshot.test.ts` | T3 | Algoritmo em `execution.service.ts` | Lógica pura |

---

## Garantias de Autorização

> Testes com tipo **DB real** requerem `DATABASE_URL` configurado.
> São excluídos automaticamente de `npx vitest run` sem banco (ver `vitest.config.ts`).

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| Consultor sem assignment recebe 403 | `consultant.plane.test.ts` | T2 | HTTP inject → `getConsultantAssignment` retorna null | API real |
| Assignment revogado (`revoked_at IS NOT NULL`) é negado | `consultant.plane.test.ts` | T3 | INSERT revogado → SQL WHERE revoked_at IS NULL | DB real |
| Assignment expirado (`expires_at < NOW()`) é negado | `consultant.plane.test.ts` | T4 | INSERT expirado → SQL WHERE expires_at > NOW() | DB real |
| API key com hash desconhecido retorna 0 rows | `compliance.guarantees.test.ts` | T6 | Query real de `requireApiKey` (hash inexistente) | DB real |
| API key inativa (`is_active=false`) excluída da auth | `compliance.guarantees.test.ts` | T6b | Chave ativa: 0 rows com FALSE, 1 row com TRUE | DB real |
| Chave expirada rejeitada pela query real | `compliance.guarantees.test.ts` | T7 | INSERT expirada + query real → 0 rows | DB real |
| Publicação exige `lifecycle_state = 'approved'` | `compliance.guarantees.test.ts` | T8 | CHECK constraint no banco | DB real |

---

## Garantias do Consultant Plane

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| Portfolio retorna array com estrutura correta | `consultant.plane.test.ts` | T1 | HTTP inject → GET /v1/consultant/portfolio | API real |
| Assignment ativo retorna 200 com dados do tenant | `consultant.plane.test.ts` | T5 | HTTP inject com assignment inserido | API real |
| `logConsultantAction` persiste com parâmetros corretos | `consultant.plane.test.ts` | T6 | INSERT + SELECT no banco real | DB real |
| `getConsultantPortfolio` retorna estrutura correta | `consultant.plane.test.ts` | T8 | Pool real + validação de shape | DB real |

---

## Garantias de Isolamento (RLS)

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `evidence_records` — org A vê; org B vê 0 rows | `compliance.guarantees.test.ts` | T10 | SET LOCAL ROLE govai_app + set_config | DB real |

---

## Garantias de Policy Snapshot

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| Novo snapshot criado para policy desconhecida | `policy.snapshot.test.ts` | T1 | INSERT RETURNING id | Lógica pura |
| Snapshot existente reutilizado (content-addressable) | `policy.snapshot.test.ts` | T2 | SELECT antes de INSERT | Lógica pura |
| Políticas idênticas → mesmo hash | `policy.snapshot.test.ts` | T3 | SHA-256 determinístico | Lógica pura |
| snapshotId propagado ao audit log | `policy.snapshot.test.ts` | T4 | Campo no payload | Lógica pura |
| Falha de DB não bloqueia execução | `policy.snapshot.test.ts` | T5 | try/catch retorna null | Lógica pura |

---

## Garantias do Shield Core (Detection Foundation)

> Todos os testes requerem `DATABASE_URL` — excluídos da suíte padrão.

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `normalizeToolName` produz chave estável | `shield.core.test.ts` | T1 | Lógica pura (trim, lower, colapso) | Lógica pura |
| `recordShieldObservation` persiste `tool_name_normalized` e hash | `shield.core.test.ts` | T2 | INSERT + SELECT no banco real | DB real |
| `processShieldObservations` cria entrada em `shield_tools` | `shield.core.test.ts` | T3 | Upsert no banco real | DB real |
| Rollup diário UNIQUE por (org, tool, period_start) | `shield.core.test.ts` | T4 | ON CONFLICT UPDATE no banco real | DB real |
| `generateShieldFindings` preenche `risk_score` e `risk_dimensions` (5 dim) | `shield.core.test.ts` | T5 | INSERT/UPDATE no banco real + validação de JSON | DB real |
| `acknowledgeShieldFinding` atualiza status + gera `shield_finding_actions` | `shield.core.test.ts` | T6 | UPDATE + INSERT no banco real | DB real |
| `promoteShieldFindingToCatalog` cria assistant draft + promoted | `shield.core.test.ts` | T7 | INSERT assistants + UPDATE findings | DB real |
| Promoção gera `evidence_record` com hash de integridade | `shield.core.test.ts` | T8 | `recordEvidence` + `linkEvidence` | DB real |
| RLS: org A vê finding; org errada recebe 0 rows | `shield.core.test.ts` | T9 | SET LOCAL ROLE govai_app + set_config | DB real |
| Endpoint GET /findings responde 200 com auth válida | `shield.core.test.ts` | T10 | Fastify inject real | API real |
| `acceptRisk` transiciona finding + campos + action log inserido | `shield.core.test.ts` | T11 | UPDATE + INSERT no banco real | DB real |
| `resolveFinding` transiciona finding + action log inserido | `shield.core.test.ts` | T12 | UPDATE + INSERT no banco real | DB real |
| `generateExecutivePosture` persiste `shield_posture_snapshots` | `shield.core.test.ts` | T13 | INSERT no banco real + SELECT de validação | DB real |
| Endpoint POST /accept-risk responde 200 | `shield.core.test.ts` | T20 | Fastify inject real | API real |
| Endpoint POST /resolve responde 200 | `shield.core.test.ts` | T21 | Fastify inject real | API real |
| Endpoint GET /posture responde 200 | `shield.core.test.ts` | T22 | Fastify inject real | API real |
| Endpoint POST /posture/generate responde 200 | `shield.core.test.ts` | T23 | Fastify inject real | API real |

---

## Garantias do Shield Risk Engine (Lógica pura)

> Testes na suíte padrão — executam sem `DATABASE_URL`.

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| Score mínimo > 0 para app desconhecido | `shield.risk-engine.test.ts` | T1 | 5 dimensões auditáveis | Lógica pura |
| Scopes sensíveis aumentam `exposure` | `shield.risk-engine.test.ts` | T2 | `Mail.Read` vs sem scopes | Lógica pura |
| 50 usuários únicos → `businessContext` ≥ 18 | `shield.risk-engine.test.ts` | T3 | Dimensão `businessContext` | Lógica pura |
| `isSanctioned=false` aumenta `baseRisk` | `shield.risk-engine.test.ts` | T4 | Penalidade de não-sanção | Lógica pura |
| 3+ fontes de sinal → `confidence` ≥ 18 | `shield.risk-engine.test.ts` | T5 | Dimensão `confidence` | Lógica pura |
| `total` ≥ 85 → `severity = 'critical'` | `shield.risk-engine.test.ts` | T6 | Threshold crítico | Lógica pura |
| `total` < 30 → `severity = 'informational'` | `shield.risk-engine.test.ts` | T7 | Threshold informacional | Lógica pura |
| `promotionCandidate = true` quando score ≥ 50 e !isSanctioned | `shield.risk-engine.test.ts` | T8 | Critério de promoção | Lógica pura |
| Score sancionado < não-sancionado (mesmo perfil) | `shield.risk-engine.test.ts` | T9 | Diferença delta mensurável | Lógica pura |
| Score é determinístico para mesmo input | `shield.risk-engine.test.ts` | T10 | SHA-256-like determinismo | Lógica pura |
| `recommendedAction` retornado e válido; `scoreVersion = '1.1'` | `shield.risk-engine.test.ts` | T11 | 4 valores válidos + versão | Lógica pura |

---

## Garantias do Shield Collector (Microsoft + Google)

> Testes T3–T8 requerem `DATABASE_URL`.

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `collectMicrosoftOAuthGrants` retorna `{ collected, normalized, errors }` | `shield.collector.test.ts` | T1 | fetch mockado | Lógica pura |
| `user_identifier_hash` = SHA-256 (64 chars), nunca email plain | `shield.collector.test.ts` | T2 | Hash verificado vs principalId | Lógica pura |
| `shield_oauth_collectors` INSERT/SELECT no banco real | `shield.collector.test.ts` | T3 | Banco real | DB real |
| `generateExecutiveReport` persiste `shield_executive_reports` | `shield.collector.test.ts` | T4 | INSERT + SELECT banco real | DB real |
| `storeGoogleCollector` armazena `admin_email_hash` (SHA-256, 64 chars) | `shield.collector.test.ts` | T5 | Hash verificado vs admin email | DB real |
| `ingestGoogleObservations` armazena `user_identifier_hash` SHA-256 | `shield.collector.test.ts` | T6 | Hash verificado + ausência de plain email | DB real |
| Atividades sem `actor.email` ignoradas sem lançar exceção | `shield.collector.test.ts` | T7 | Input inválido parcial | DB real |
| Nenhum campo de identificador primário contém email plain (`@`) | `shield.collector.test.ts` | T8 | SELECT de todos os hashes no banco | DB real |

---

## Garantias do Shield Network Collector (S1-R)

> Testes T3–T6 requerem `DATABASE_URL`.

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `normalizeNetworkSignal` produz `tool_name_normalized` estável e hash SHA-256 | `shield.network-collector.test.ts` | T1 | Lógica pura (trim, lower, sha256) | Lógica pura |
| `toolNameNormalized` de `normalizeNetworkSignal` é idêntico ao de `normalizeToolName` | `shield.network-collector.test.ts` | T2 | Consistência de normalização | Lógica pura |
| `storeNetworkCollector` persiste collector com `status=active` | `shield.network-collector.test.ts` | T3 | INSERT no banco real + SELECT | DB real |
| `ingestNetworkBatch` persiste `user_identifier_hash` SHA-256 (64 chars), nunca email plain | `shield.network-collector.test.ts` | T4 | Hash verificado + ausência de `@` | DB real |
| Eventos de rede alimentam `shield_observations_raw` com `source_type='network'` | `shield.network-collector.test.ts` | T5 | SELECT no pipeline principal do Shield | DB real |
| RLS: `shield_network_events_raw` isolado — org errada vê 0 rows | `shield.network-collector.test.ts` | T6 | SET LOCAL ROLE govai_app + set_config | DB real |

---

## Garantias do Shield Multisource Resolution (S1-R)

> Testes T3–T13 requerem `DATABASE_URL`.

| Garantia | Arquivo de Teste | Caso | Mecanismo | Tipo |
|----------|-----------------|------|-----------|------|
| `mergeOrUpdateFinding` (1ª fonte) cria finding com `source_types=['oauth']`, `correlation_count=1` | `shield.multisource-resolution.test.ts` | T1 | Lógica pura (mock pool) | Lógica pura |
| Segunda fonte faz merge: `source_types=['oauth','network']`, `correlation_count=2`, `risk_score` elevado | `shield.multisource-resolution.test.ts` | T2 | Lógica pura (mock pool) | Lógica pura |
| `mergeOrUpdateFinding` no banco real cria + atualiza finding com múltiplas fontes | `shield.multisource-resolution.test.ts` | T3 | INSERT/UPDATE no banco real | DB real |
| `dedupeFindings` consolida duplicatas: mantém oldest, fecha outros como `resolved` | `shield.multisource-resolution.test.ts` | T4 | INSERT forçado + dedupeFindings + SELECT | DB real |
| `syncShieldToolsWithCatalog` mapeia `lifecycle_state=published` → `approval_status=approved`, `sanctioned=true` | `shield.multisource-resolution.test.ts` | T5 | INSERT assistant + syncShieldToolsWithCatalog | DB real |
| `generateShieldFindings` não cria finding para ferramenta aprovada (`sanctioned=true`) | `shield.multisource-resolution.test.ts` | T6 | `approval_status` real do catálogo | DB real |
| `computeOwnerCandidate` retorna hash dominante (≥3 obs); retorna `null` quando dados insuficientes | `shield.multisource-resolution.test.ts` | T7 | SELECT frequency no banco real | DB real |
| `promoteShieldFindingToCatalog` funciona com finding multissinal; cria evidence + action log | `shield.multisource-resolution.test.ts` | T8 | INSERT assistants + evidence + action log | DB real |
| RLS: `shield_findings` isolado — org errada vê 0 findings da org correta | `shield.multisource-resolution.test.ts` | T9 | SET LOCAL ROLE govai_app + set_config | DB real |
| `listShieldFindings` retorna array para a org correta | `shield.multisource-resolution.test.ts` | T10 | SELECT no banco real | DB real |
| Endpoint `POST /network/collectors` → 201 com collector record | `shield.multisource-resolution.test.ts` | T11 | Fastify inject real | API real |
| Endpoint `POST /network/collectors/:id/ingest` → 200 com `ingested=1` | `shield.multisource-resolution.test.ts` | T12 | Fastify inject real | API real |
| Endpoint `GET /findings` → 200 com array | `shield.multisource-resolution.test.ts` | T13 | Fastify inject real | API real |

---

## Legenda dos Tipos

| Tipo | Descrição |
|------|-----------|
| **DB real** | Conecta ao PostgreSQL real; sem mocks de pool ou trigger |
| **API real** | Usa Fastify inject real com pool PostgreSQL real |
| **Lógica pura** | Sem I/O externo; testa apenas lógica JavaScript/TypeScript |

---

## Como Executar

```bash
# Suíte padrão (sem banco) — 542 testes, 49 arquivos
npx vitest run

# Apenas garantias de compliance (requer banco)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose

# Apenas Consultant Plane (requer banco)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/consultant.plane.test.ts --reporter=verbose

# Shield Network Collector (requer banco — 6 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.network-collector.test.ts --reporter=verbose

# Shield Multisource Resolution (requer banco — 13 testes)
DATABASE_URL=postgresql://... npx vitest run src/__tests__/shield.multisource-resolution.test.ts --reporter=verbose

# Todos os testes de integração (requer banco)
DATABASE_URL=postgresql://... npx vitest run --reporter=verbose
```

---

## Versão

| Campo | Valor |
|-------|-------|
| Versão da plataforma | v1.3.0 |
| Suíte padrão (sem DATABASE_URL) | 542 testes · 49 arquivos |
| Garantias com banco (DATABASE_URL) | +62 testes DB integration confirmados |
| Total confirmado com banco | 604 (542 + 62 garantias DB) |
| Última atualização | 2026-03-22 |
| Sprint | S1-R — Shield Multisource Resolution + Baseline Sanity |
