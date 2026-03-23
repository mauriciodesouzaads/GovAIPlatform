# ADR-007 — Shield S2 / Finding Workflow & Consultant Value

**Data:** 2026-03-22
**Status:** Accepted
**Sprint:** Shield S2 (builds on F + F2a + Shield Complete + S1-R)

---

## Contexto

Sprints anteriores entregaram o pipeline completo de detecção Shield (F, F2a), a correlação multissinal (S1-R), e o workflow básico de findings. A Sprint S2 fecha a lacuna de valor operacional: workflow completo e auditável por finding + visão consultiva real dos dados Shield.

---

## O que a Sprint S2 entrega

| Componente | Descrição |
|-----------|-----------|
| `052_shield_finding_workflow.sql` | Enriquece `shield_findings` com campos de workflow (owner_assigned_at/by, owner_note, dismissed_reason, reopened_at/by, closed_reason, last_action_at); expande `shield_finding_actions` com assign_owner + comment + metadata JSONB; adiciona `unresolved_critical` a `shield_posture_snapshots` |
| `src/lib/shield.ts` (adições) | `assignShieldFindingOwner`, `appendShieldFindingComment`, `listShieldFindingActions`, `listShieldPostureForConsultant` |
| `src/lib/shield.ts` (alterações) | `acceptRisk` e `dismissFinding` passam a **exigir** justificativa/motivo (lança erro se vazio); `reopenFinding` persiste `reopened_at/by`; `generateExecutivePosture` computa e persiste `unresolved_critical`; `insertFindingAction` (helper privado) atualiza `last_action_at` em toda ação |
| `src/routes/shield.routes.ts` (adições) | `POST /findings/:id/assign-owner`, `GET /findings/:id/actions`, `GET /consultant/tenants/:tenantOrgId/shield/posture`, `GET /consultant/tenants/:tenantOrgId/shield/findings`, `GET /consultant/tenants/:tenantOrgId/shield/findings/:id/actions` |
| `src/__tests__/shield.workflow.test.ts` | 17 testes T1–T17 (T1–T12 banco real, T13–T17 API real) |
| `docs/ADR-007-shield-s2-workflow-consultant.md` | Este documento |

---

## Lifecycle efetivo de finding

O campo `status` é o estado canônico do finding. Não foi criado `workflow_state` separado para evitar conflito com o baseline.

| Status | Transições válidas | Action log |
|--------|-------------------|-----------|
| `open` | → acknowledged, accepted_risk, dismissed, resolved, promoted | — |
| `acknowledged` | → accepted_risk, dismissed, resolved, promoted | acknowledge |
| `accepted_risk` | → open (reopen) | accept_risk |
| `dismissed` | → open (reopen) | dismiss |
| `resolved` | → open (reopen) | resolve |
| `promoted` | (terminal) | promote |

Ações adicionais (não alteram status):
- `assign_owner` — atribui owner candidate, persiste owner_assigned_at/by
- `comment` — texto livre, não altera estado

Toda ação grava `last_action_at = NOW()` via `insertFindingAction` (helper privado).

---

## Decisões de design

**1. `acceptRisk` e `dismissFinding` exigem justificativa**

Justificativa para `acceptRisk.note` e `dismissFinding.reason` são obrigatórias tanto no domínio (lança erro se vazio) quanto na rota (400 se ausente). Motivo: compliance — toda decisão de aceite ou descarte deve ter trilha auditável com texto. Ações sem justificativa são rejeitadas antes de chegar ao banco.

**2. `last_action_at` via helper central**

`insertFindingAction` (privado) sempre executa `UPDATE shield_findings SET last_action_at = NOW()`. Garante que qualquer nova ação futura também atualize o campo sem precisar lembrar de fazê-lo nas funções de domínio individualmente.

**3. Visão consultiva não usa mocks de RLS**

As rotas `GET /consultant/tenants/:tenantOrgId/shield/*` chamam `getConsultantAssignment` para validar o assignment e retornam 403 rigoroso se ausente. Em seguida, configuram `app.current_org_id = tenantOrgId` (session-level, false) para que a RLS do PostgreSQL isole os dados do tenant. Não há bypass silencioso.

**4. `dismissFinding` persiste `dismissed_reason` na linha do finding**

Além do action log (que é imutável), o motivo é persistido em `shield_findings.dismissed_reason` para facilitar consultas analíticas sem join com `shield_finding_actions`.

**5. `unresolved_critical` no posture snapshot**

Calculado como `COUNT(*) WHERE severity='critical' AND status NOT IN ('dismissed','resolved','promoted')`. Inclui `accepted_risk` pois o risco foi aceito mas não eliminado. Persiste em `shield_posture_snapshots.unresolved_critical`.

---

## Relação com o Consultant Plane

As rotas `GET /consultant/tenants/:tenantOrgId/shield/*` usam `getConsultantAssignment` do mesmo módulo `consultant-auth.ts`. O padrão é idêntico às rotas existentes em `consultant.routes.ts`:

1. Verificar `userId` no `request.user`
2. Chamar `getConsultantAssignment(pgPool, userId, tenantOrgId)` → 403 se null
3. Configurar `app.current_org_id = tenantOrgId` (session-level)
4. Registrar ação em `consultant_audit_log` via `logConsultantAction`

O consultant plane continua **read-only** para dados Shield. Nenhuma ação de escrita (assign-owner, accept-risk, etc.) é exposta via rotas consultant.

---

## Relação com o Evidence Domain

`promoteShieldFindingToCatalog` continua gerando `evidence_record` (categoria: publication) e linkando ao finding via `evidence_links`. As novas ações (assign_owner, comment, accept_risk, dismiss, resolve, reopen) NÃO geram evidências — apenas action log. Somente `promote` gera evidence formal, por ser a transição com impacto no catálogo de capacidades.

---

## O que a Sprint S2 NÃO entrega

| Item | Motivo / Sprint futura |
|------|------------------------|
| Browser/endpoint collector | Sprint G |
| Notification service (alertas, e-mail) | Sprint G |
| `consultant_alerts` gerados de findings | Sprint G |
| Dashboard UI de findings no Admin UI | Sprint G |
| ML/IA para owner resolution | Sprint H |
| Correlação com SIEM externo (Splunk/Elastic) | Sprint H |
| Benchmark setorial de risco | Fora do escopo atual |
| Auditoria cross-tenant de consultores (relatório) | Sprint H |
| Roles granulares por tenant (viewer/editor/admin) | Sprint G |

---

## Impacto em schema

- **Nova migration**: `052_shield_finding_workflow.sql`
- **Colunas novas em `shield_findings`**: owner_assigned_at, owner_assigned_by, owner_note, dismissed_reason, reopened_at, reopened_by, closed_reason, last_action_at
- **Colunas novas em `shield_finding_actions`**: metadata JSONB; tipos expand: assign_owner, comment
- **Colunas novas em `shield_posture_snapshots`**: unresolved_critical INTEGER
- **Total de migrations**: 41 (011–052, excluindo 050)

---

## Impacto em testes

- `shield.workflow.test.ts`: 17 testes (T1–T12 banco real, T13–T17 API real)
- Suíte padrão: **542 testes · 49 arquivos** (inalterado)
- Suíte DB integration: +17 testes adicionais (shield.workflow)
- Total confirmado com banco: **621** (542 + 79 DB integration)

---

## Próxima sprint sugerida (Sprint G — Collectors + Workers + Dashboard UI)

- Worker BullMQ para coleta periódica (admin-triggered → worker-triggered)
- Alertas de consultant gerados de findings (`consultant_alerts`)
- Dashboard UI de findings no Admin UI Next.js
- Browser/endpoint collector (agent-based)
- DNS/proxy collector com packet tap mínimo
