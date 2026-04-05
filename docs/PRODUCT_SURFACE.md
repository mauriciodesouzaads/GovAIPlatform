<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-04-05 15:32 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Product Surface

**Gerado em:** 2026-04-05 15:32 UTC

---

## Gateway Core

- `POST /v1/execute/:id` — execução de assistente com pipeline completo
- `GET  /v1/health` — health check
- Auth: JWT Bearer + API Key (`sk-govai-...`)
- DLP: Presidio NLP + regex
- OPA WASM: OWASP LLM Top 10 (LLM01–LLM10)
- HITL: aprovação humana
- Audit log: HMAC-SHA256 signed
- FinOps: tokens/custo por org

## Policy

- `GET/POST /v1/admin/policies`
- `GET/POST /v1/admin/policy-snapshots`
- `GET/POST /v1/admin/policy-exceptions`

## Evidence

- `GET/POST /v1/admin/evidence`

## Catalog

- `GET/POST /v1/admin/catalog`
- `GET/PATCH/DELETE /v1/admin/catalog/:id`
- Lifecycle: draft → under_review → approved → official → suspended → archived

## Public Endpoints

- `GET /v1/public/assistant/:assistantId` — safe public info para chat UI (requer API Key)

## Platform Admin (platform_admin role)

- `POST /v1/admin/organizations` — criar organização
- `PATCH /v1/admin/organizations/:id` — atualizar organização
- `POST /v1/admin/organizations/:id/invite-admin` — convidar admin para org
- `GET /v1/admin/platform/organizations` — listar todas as orgs
- `GET /v1/admin/platform/users` — listar todos os usuários
- `POST/GET/DELETE /v1/admin/platform/consultant-assignments` — atribuições de consultor
- `POST /v1/admin/platform/consultant-alerts` — alertas de consultor

## Models

- `GET /v1/admin/models` — listar modelos LLM disponíveis

## Consultant Plane

- `GET /v1/consultant/tenants/:tenantOrgId/*`
- Shield: 3 rotas (posture, findings, actions)

## Shield — Shadow-AI Detection (35 rotas total)

**Admin (32 rotas):**

| Categoria | Endpoints |
|-----------|-----------|
| Ingestion | POST /observations, POST /process |
| Findings | POST /generate, GET /, POST /:id/{acknowledge,accept-risk,dismiss,resolve,reopen,promote,assign-owner}, GET /:id/actions |
| Posture | GET /, POST /generate, GET /history |
| Collectors | POST /, POST /:id/trigger |
| Google | POST /google/collectors, POST /google/collectors/:id/{token,fetch} |
| Network | POST /network/collectors, POST /network/collectors/:id/ingest |
| Health | GET /health, POST /health/{success,failure} |
| Reports | GET /executive |
| Metrics | GET /metrics |
| Export | GET /findings, GET /findings.csv, GET /posture |
| Sync | POST /dedupe, POST /sync-catalog |

**BullMQ Automation (5 cron jobs):**

- `generate-findings` — gera findings automáticos
- `dedupe-findings` — deduplicação de findings
- `posture-snapshot` — snapshot de postura
- `collect-oauth` — coleta via OAuth
- `collect-google` — coleta via Google Workspace

## Architect Domain (20 endpoints)

- `POST /v1/admin/architect/cases` — criar caso de demanda
- `GET /v1/admin/architect/cases` — listar casos
- `GET /v1/admin/architect/cases/:id` — detalhe do caso
- `PATCH /v1/admin/architect/cases/:id/status` — atualizar status
- `POST/PUT /v1/admin/architect/cases/:id/contract` — problem contract
- `POST /v1/admin/architect/cases/:id/contract/accept` — aceitar contrato
- `POST /v1/admin/architect/cases/:id/discover` — discovery stateful
- `POST /v1/admin/architect/cases/:id/discover/answer` — responder discovery
- `POST /v1/admin/architect/cases/:id/discover/questions` — perguntas discovery
- `GET /v1/admin/architect/cases/:id/discover/status` — status discovery
- `POST /v1/admin/architect/cases/:id/decisions` — criar ADR
- `POST /v1/admin/architect/decisions/:id/{propose,approve,reject,compile}` — workflow ADR
- `POST /v1/admin/architect/decisions/:id/document` — gerar documento ADR via LiteLLM
- `GET /v1/admin/architect/cases/:id/work-items` — listar work items
- `PATCH /v1/admin/architect/work-items/:id` — atualizar work item
- `POST /v1/admin/architect/work-items/:id/dispatch` — despachar work item
- `POST /v1/admin/architect/cases/:id/workflow/dispatch-all` — despachar todos
- `GET /v1/admin/architect/cases/:id/summary` — gerar resumo via LiteLLM

---

## Não implementado (roadmap)

- SSE / browser extension (ADR-004)
- CASB integration
- Agno runtime (stub only, AGNO_ENABLED=false)
- Claude Code adapter (enum only, sem adapter implementado)

---

## Admin UI (Next.js 14) — 15 páginas

| Rota | Página | Roles |
|------|--------|-------|
| `/` | Dashboard — Security Command Center | todos |
| `/playground` | Playground — teste com governança completa | admin, sre, operator |
| `/logs` | Audit Logs — rastreabilidade LGPD/GDPR | todos |
| `/assistants` | Assistants & RAG — gestão de assistentes | admin, sre, operator |
| `/api-keys` | API Keys | admin |
| `/approvals` | Approvals — fila HITL | admin, sre, dpo |
| `/compliance` | Compliance LGPD — toggles de conformidade | admin, dpo |
| `/reports` | Reports — exportação PDF/CSV | admin, dpo, auditor |
| `/shield` | Shield Detection — shadow-AI | admin, sre, dpo, auditor |
| `/catalog` | Catálogo de Agentes — registry formal | admin, operator, auditor |
| `/consultant` | Painel do Consultor | admin, sre, dpo |
| `/architect` | Arquiteto de IA — demandas e ADRs | admin, operator, dpo |
| `/organizations` | Organizações (platform_admin) | platform_admin |
| `/login` | Login — JWT + SSO (Microsoft Entra, Okta) | público |
| `/chat/[assistantId]` | Chat Governado — interface end-user | API Key |
