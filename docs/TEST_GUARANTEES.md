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
| `generateShieldFindings` cria finding open para ferramenta unknown | `shield.core.test.ts` | T5 | INSERT/UPDATE no banco real | DB real |
| `acknowledgeShieldFinding` atualiza status + timestamps | `shield.core.test.ts` | T6 | UPDATE no banco real | DB real |
| `promoteShieldFindingToCatalog` cria assistant draft + promoted | `shield.core.test.ts` | T7 | INSERT assistants + UPDATE findings | DB real |
| Promoção gera `evidence_record` com hash de integridade | `shield.core.test.ts` | T8 | `recordEvidence` + `linkEvidence` | DB real |
| RLS: org A vê finding; org errada recebe 0 rows | `shield.core.test.ts` | T9 | SET LOCAL ROLE govai_app + set_config | DB real |
| Endpoint GET /findings responde 200 com auth válida | `shield.core.test.ts` | T10 | Fastify inject real | API real |

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

# Todos os testes de integração (requer banco)
DATABASE_URL=postgresql://... npx vitest run --reporter=verbose
```

---

## Versão

| Campo | Valor |
|-------|-------|
| Versão da plataforma | v1.1.1 |
| Suíte padrão (sem DATABASE_URL) | 542 testes · 49 arquivos |
| Garantias com banco (DATABASE_URL) | +29 testes (19 anteriores + 10 Shield Core) |
| Total confirmado com banco | 571+ (542 + 29 garantias) |
| Última atualização | 2026-03-22 |
| Sprint | F — Shield Core / Detection Foundation |
