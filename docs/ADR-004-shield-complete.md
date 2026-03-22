# ADR-004 — Shield Complete / Detection & Risk Intelligence Plane

**Data:** 2026-03-22
**Status:** Accepted
**Sprint:** Shield Complete (builds on F + F2a)

---

## Contexto

A Sprint F entregou o Shield Core (4 tabelas, normalização de nomes, findings básicos).
A Sprint F2a adicionou o Microsoft OAuth collector real, risk engine de 5 dimensões e executive report.
Esta sprint consolida o domínio com workflow completo de findings, Google OAuth collector, postura executiva persistida e integração com o Consultant Plane.

---

## O que a Sprint Shield Complete entrega

| Componente | Descrição |
|-----------|-----------|
| `049_shield_complete.sql` | Enriquece `shield_tools` e `shield_findings`; cria 4 novas tabelas |
| `src/lib/shield.ts` | Workflow completo: `acceptRisk`, `dismissFinding`, `resolveFinding`, `reopenFinding`, `generateExecutivePosture`, `insertFindingAction` |
| `src/lib/shield-google-collector.ts` | Google Workspace Admin SDK collector: `storeGoogleCollector`, `storeGoogleToken`, `fetchGoogleObservations`, `ingestGoogleObservations` |
| `src/lib/shield-risk-engine.ts` | `scoreVersion = '1.1'`, `recommendedAction`, `category` adicionados ao `RiskScore` |
| `src/lib/shield-report.ts` | Agora persiste `shield_posture_snapshots` em paralelo ao relatório |
| `src/routes/shield.routes.ts` | 13+ novos endpoints de finding workflow, postura e Google collectors |
| `src/routes/consultant.routes.ts` | Leitura de postura e findings de tenants via Consultant Plane |
| `src/__tests__/shield.core.test.ts` | 23 testes T1–T13, T20–T23 com PostgreSQL real |
| `src/__tests__/shield.risk-engine.test.ts` | T1–T11 lógica pura (suíte padrão) |
| `src/__tests__/shield.collector.test.ts` | T1–T8 (T1–T4 lógica pura, T5–T8 banco real) |
| `docs/ADR-004-shield-complete.md` | Este documento |

### Decisões de design

**1. `shield_finding_actions` — imutável por concessão de permissão**

`GRANT SELECT, INSERT ON shield_finding_actions TO govai_app` — sem UPDATE, sem DELETE.
A imutabilidade é garantida no nível de permissão PostgreSQL, não apenas por convenção de código.

**2. `user_identifier_hash = SHA-256(email)` — sem exceções**

Nenhum campo de identificador primário armazena email plain. Esta regra se aplica a:
- `shield_observations_raw.user_identifier_hash`
- `shield_google_collectors.admin_email_hash`
Verificado por T8 no `shield.collector.test.ts` via SELECT direto no banco.

**3. `set_config('app.current_org_id', $1, false)` — session-level, não transaction-local**

Padrão estabelecido no ADR-003, mantido em todos os novos endpoints. O `finally` sempre emite `set_config('app.current_org_id', '', false)`.

**4. `token_hash` para deduplicação sem exposição**

`shield_google_tokens.token_hash = SHA-256(accessToken)` permite verificar se um token já foi visto sem nunca armazenar o token plain. O token é persistido apenas no campo `access_token_encrypted` (responsabilidade do caller criptografar).

**5. `sourceType = 'oauth'` — não inventar valores fora do CHECK**

O CHECK constraint de `shield_observations_raw.source_type` é `('manual','oauth','network','browser','api')`. O Google collector usa `'oauth'`, não `'google_oauth'` nem qualquer outro valor não registrado.

**6. Workflow de finding com evidence em promoção**

`promoteFindingToCatalog` sempre:
- cria `assistant` com `lifecycle_state = 'draft'`
- atualiza finding para `promoted`
- insere em `shield_finding_actions` com `action_type = 'promote'`
- chama `recordEvidence` + `linkEvidence`
- executa tudo em transação única

Outros estados (`acknowledged`, `accepted_risk`, `dismissed`, `resolved`, `reopen`) inserem em `shield_finding_actions` mas não necessariamente geram evidence record.

**7. Google Admin SDK Reports API — somente eventos `authorize`**

`fetchGoogleObservations` consulta `admin/reports/v1/activity/users/all/applications/token`
e filtra apenas `eventName=authorize`. Segue paginação via `nextPageToken`. Erros de fetch
retornam em `{ activities: [], errors: [...] }` sem lançar exceção — a persistência de
observações anteriores não é comprometida por falha de coleta.

**8. Scores auditáveis — `scoreVersion = '1.1'`**

Todo `RiskScore` agora inclui `scoreVersion` para rastreabilidade de retrocomputações.
`recommendedAction` deriva do total: ≥70 → `restrict_and_catalog`, ≥50 → `catalog_and_review`,
≥30 → `monitor`, <30 → `observe`.

---

## O que a Sprint Shield Complete NÃO entrega

| Item | Motivo / Sprint futura |
|------|------------------------|
| Browser extension collector | Requer SDK de extensão + distribution pipeline — Sprint G |
| DNS/proxy/SWG collector | Dependência de infrastructure tap — Sprint G |
| CASB / SSE completo | Arquitetura de data plane separada — fora do escopo atual |
| Worker assíncrono de coleta | BullMQ job periódico — Sprint G |
| Alertas de consultant gerados de findings | `consultant_alerts` — Sprint F2b |
| Decifragem de tokens no backend | `access_token_encrypted` armazenado pelo caller — Sprint G |
| Integração com LLM para categorização de ferramenta | Enriquecimento manual ou via catalog — Sprint H |
| Multi-tenant SaaS managed service | Arquitetura single-binary atual é suficiente para early customers |

O diferencial desta plataforma é: **governança + evidência + catalog promotion + consultoria operacional**, não volume bruto de telemetria ou paridade com SSE/CASB.

---

## Collectors reais cobertos

| Collector | Protocolo | Tabela | Status |
|-----------|-----------|--------|--------|
| Microsoft Graph (OAuth 2.0) | `v1.0/oauth2PermissionGrants` | `shield_oauth_collectors` / `shield_oauth_grants` | Ativo desde F2a |
| Google Workspace Admin SDK | `admin/reports/v1/activity` | `shield_google_collectors` / `shield_google_tokens` | Ativo desde Shield Complete |
| Manual (admin input) | REST API `/v1/admin/shield/observations` | `shield_observations_raw` | Ativo desde Sprint F |

---

## Impacto em schema

- **Nova migration**: `049_shield_complete.sql` — enriquece 2 tabelas, cria 4 novas
- **Total de tabelas Shield**: 11
- **Total de migrations**: 49

---

## Impacto em testes

- `shield.core.test.ts`: 23 testes (T1–T13, T20–T23) — integração com banco real
- `shield.collector.test.ts`: 8 testes (T1–T8, T5–T8 com banco real)
- `shield.risk-engine.test.ts`: 11 testes (T1–T11) — lógica pura, suíte padrão
- Suíte padrão: **554 testes · 50 arquivos**
- Suíte padrão + DB integration: **590+ testes** (depende de DATABASE_URL disponível)
