# GovAI Platform — Matriz de Garantias Auditáveis

Este documento lista garantias de segurança e conformidade verificáveis via testes automatizados.
Auditores externos podem executar `npx vitest run --reporter=verbose` para validar cada garantia.

---

## Garantias de Imutabilidade

| Garantia | Arquivo de Teste | Caso | Mecanismo |
|----------|-----------------|------|-----------|
| `audit_logs` é imutável | `compliance.guarantees.test.ts` | T1 | Trigger BEFORE UPDATE/DELETE |
| `policy_snapshots` é imutável | `compliance.guarantees.test.ts` | T2 | Trigger BEFORE UPDATE/DELETE |
| `evidence_records` é imutável | `compliance.guarantees.test.ts` | T3 | Trigger BEFORE UPDATE/DELETE |
| `catalog_reviews` é imutável | `compliance.guarantees.test.ts` | T4 | Trigger BEFORE UPDATE/DELETE |
| `consultant_audit_log` é imutável | `compliance.guarantees.test.ts` | T5 | Trigger BEFORE UPDATE/DELETE |

---

## Garantias de Integridade Criptográfica

| Garantia | Arquivo de Teste | Caso | Mecanismo |
|----------|-----------------|------|-----------|
| `integrity_hash` = SHA-256(orgId\|category\|eventType\|metadata) | `compliance.guarantees.test.ts` | T6 | Algoritmo em `evidence.ts` |
| `integrity_hash` é determinístico (mesmo input → mesmo hash) | `compliance.guarantees.test.ts` | T10 | SHA-256 puro (sem salt) |
| Hashes distintos para metadados distintos | `compliance.guarantees.test.ts` | T10 | Resistência a colisão SHA-256 |
| `policy_hash` = SHA-256(JSON(policyJson)) | `policy.snapshot.test.ts` | T3 | Algoritmo em `execution.service.ts` |

---

## Garantias de Autorização

| Garantia | Arquivo de Teste | Caso | Mecanismo |
|----------|-----------------|------|-----------|
| Consultor sem assignment recebe 403 | `consultant.plane.test.ts` | T2 | `getConsultantAssignment` retorna null |
| Assignment revogado (`revoked_at IS NOT NULL`) é negado | `consultant.plane.test.ts` | T3 | SQL WHERE revoked_at IS NULL |
| Assignment expirado (`expires_at < NOW()`) é negado | `consultant.plane.test.ts` | T4 | SQL WHERE expires_at > NOW() |
| API key revogada (`is_active = false`) bloqueia auth | `compliance.guarantees.test.ts` | T9 | Lógica de middleware |
| Publicação exige `lifecycle_state = 'approved'` | `compliance.guarantees.test.ts` | T8 | Guardrail em `assistants.routes.ts` |

---

## Garantias do Consultant Plane

| Garantia | Arquivo de Teste | Caso | Mecanismo |
|----------|-----------------|------|-----------|
| Portfolio retorna array vazio sem assignments | `consultant.plane.test.ts` | T1 | Query filtrada por `is_active = true` |
| Assignment com future `expires_at` é permitido | `consultant.plane.test.ts` | T5 | Query SQL correta |
| `logConsultantAction` persiste com parâmetros corretos | `consultant.plane.test.ts` | T5 | INSERT em `consultant_audit_log` |
| `logConsultantAction` é não-fatal (erros de DB não propagam) | `consultant.plane.test.ts` | T6 | try/catch em `consultant-auth.ts` |
| Alertas filtrados por `consultant_id` | `consultant.plane.test.ts` | T7 | SQL WHERE `consultant_id = $1` |
| Acknowledge protege por `consultant_id` (ownership) | `consultant.plane.test.ts` | T8 | WHERE `consultant_id = $1` no UPDATE |

---

## Garantias de Policy Snapshot

| Garantia | Arquivo de Teste | Caso | Mecanismo |
|----------|-----------------|------|-----------|
| Novo snapshot criado para policy desconhecida | `policy.snapshot.test.ts` | T1 | INSERT RETURNING id |
| Snapshot existente reutilizado (content-addressable) | `policy.snapshot.test.ts` | T2 | SELECT antes de INSERT |
| Políticas idênticas → mesmo hash | `policy.snapshot.test.ts` | T3 | SHA-256 determinístico |
| snapshotId propagado ao audit log | `policy.snapshot.test.ts` | T4 | Campo no payload |
| Falha de DB não bloqueia execução | `policy.snapshot.test.ts` | T5 | try/catch retorna null |

---

## Como Executar

```bash
# Todos os testes (542 testes, 51 arquivos)
npx vitest run

# Apenas garantias de compliance
npx vitest run src/__tests__/compliance.guarantees.test.ts --reporter=verbose

# Apenas Consultant Plane
npx vitest run src/__tests__/consultant.plane.test.ts --reporter=verbose

# Testes de imutabilidade + evidence
npx vitest run src/__tests__/evidence.domain.test.ts src/__tests__/policy.snapshot.test.ts --reporter=verbose
```

---

## Versão

| Campo | Valor |
|-------|-------|
| Versão da plataforma | v1.1.1 |
| Total de testes | 560+ (pós Sprint E) |
| Última atualização | 2026-03-22 |
| Sprint | E — Consultant Plane |
