<!-- GENERATED — bash scripts/audit_project_state.sh — 2026-03-28 05:16 UTC -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Product Surface

**Gerado em:** 2026-03-28 05:16 UTC

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
- Lifecycle: draft → review → approved → deprecated

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

---

## Não implementado (roadmap)

- BullMQ workers (coleta automática)
- SSE / browser extension (ADR-004)
- CASB integration

---

## Admin UI (Next.js 14)

Dashboard · Fila HITL · Playground · RAG Upload · Relatórios compliance
