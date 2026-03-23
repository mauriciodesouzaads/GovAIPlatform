# GovAI Platform — Product Surface

> Superfície de produto implementada e testada. Atualizar após cada sprint.
> Números derivados de `bash scripts/audit_project_state.sh`.

---

## Domínios implementados

### 1. Gateway de Governança AI

Pipeline determinístico que intercepta toda requisição a LLMs antes de chegar ao provedor.

| Componente | Descrição |
|------------|-----------|
| DLP Engine | Presidio NLP (spaCy PT-BR) + Regex — CPF, CNPJ, PIX, cartão, email |
| OPA Policy Engine | WASM-compiled Rego, OWASP LLM Top 10 (LLM01–LLM10) |
| HITL Approval | Fila BullMQ, 48h TTL, approve/reject no Admin UI |
| Audit Log | HMAC-SHA256 signed, imutável, LGPD/GDPR ready |
| LLM Agnostic | Groq, OpenAI, Anthropic via LiteLLM proxy |

### 2. Multi-tenant RLS

- Isolamento por `org_id` com PostgreSQL Row-Level Security
- `set_config('app.current_org_id', $1, false)` — session-local, sempre limpo em `finally`
- `platform_admin` com `BYPASSRLS` para workers cross-tenant

### 3. Shield — AI Shadow IT Detection

Detecta e governa uso não-autorizado de ferramentas AI na organização.

#### Collectors implementados

| Collector | Fonte | Migration |
|-----------|-------|-----------|
| Microsoft OAuth | Microsoft Graph API (Teams, Outlook, SharePoint) | 048 |
| Google Workspace | Admin SDK (Gmail, Drive, Chat) | 049 |
| Network/SWG/Proxy | Logs de tráfego de rede | 051 |

#### Pipeline Shield

```
Collector → shield_observations_raw → shield_rollups → shield_findings
                                                              ↓
                                              Risk Engine (5D scoring)
                                                              ↓
                                         shield_posture_snapshots (executive view)
```

#### Workflow de findings

| Status | Transição | Restrição |
|--------|-----------|-----------|
| `open` | → `promoted` | `promoteShieldFindingToCatalog` |
| `open` | → `accepted_risk` | `acceptRisk` — note obrigatório |
| `open` | → `dismissed` | `dismissFinding` — reason obrigatório |
| `open/promoted` | → `resolved` | `resolveFinding` |
| `resolved/dismissed` | → `open` | `reopenFinding` |
| qualquer | → assign owner | `assignShieldFindingOwner` |

#### Risk Engine (5D scoring)

| Dimensão | Peso | Descrição |
|----------|------|-----------|
| Severity | 25% | Nível de risco do finding |
| Exposure | 20% | Usuários afetados |
| Recency | 20% | Última observação |
| Velocity | 20% | Aceleração de uso |
| Business Impact | 15% | Impacto no negócio |

#### S3 — Enterprise Hardening

| Feature | Descrição |
|---------|-----------|
| Collector Health | success_count, failure_count, health_status (healthy/degraded/error) |
| Posture History | Histórico completo de snapshots consultável por tenant |
| Coverage Ratio | governed_tools / total_tools (approval_status != 'unknown') |
| Export JSON | `GET /v1/admin/shield/export/findings` — findings com todos os campos |
| Export CSV | `GET /v1/admin/shield/export/findings.csv` — download direto |
| Export Posture | `GET /v1/admin/shield/export/posture` — snapshot recente + histórico |
| Métricas | `GET /v1/admin/shield/metrics` — KPIs operacionais do Shield |

### 4. Consultant Plane

- Cross-tenant auth via `consultant_assignments` + RBAC
- Tenant sem assignment → 403 estrito
- `GET /v1/admin/shield/consultant/tenants/:tenantOrgId/shield/posture`
- `GET /v1/admin/shield/consultant/tenants/:tenantOrgId/shield/findings`
- `GET /v1/admin/shield/consultant/tenants/:tenantOrgId/shield/findings/:id/actions`

### 5. Evidence Domain

- `recordEvidence`, `linkEvidence`, `getEvidenceChain`
- Suporte a compliance LGPD/SOC2/ISO27001

### 6. API Keys & Auth

| Feature | Detalhe |
|---------|---------|
| API Keys | Hash bcrypt, prefix `sk-govai-`, rotação automática TTL 90 dias |
| JWT | Assinado com `JWT_SECRET` ≥ 32 chars |
| SSO/OIDC | Microsoft Entra ID, Okta, qualquer IdP OIDC; JIT provisioning |
| Rate limiting | Login: 10 req/15min; Execute: 100 req/1min; por IP |

### 7. FinOps & Observabilidade

| Feature | Detalhe |
|---------|---------|
| Token tracking | Ledger por execução, custo estimado por org |
| Prometheus | `/metrics` (requer `METRICS_API_KEY`) |
| Grafana | Dashboards operacionais |
| Langfuse | Export de telemetria via worker assíncrono |
| BYOK | AES-256-GCM envelope com Org Master Key, Crypto-Shredding |

### 8. Admin UI

| Feature | Detalhe |
|---------|---------|
| Stack | Next.js 14 App Router + Tailwind CSS v4 + TypeScript strict |
| Dashboard | Métricas em tempo real (executions, violations, tokens) |
| HITL | Fila de aprovação/rejeição |
| Playground | Teste do pipeline de governança |
| Reports | Compliance PDF/CSV exportável |
| E2E | Playwright — 5 testes (login, dashboard, assistants, playground, HITL) |

---

## Shield API — 35 rotas (`/v1/admin/shield/`)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/tools` | Listar ferramentas detectadas |
| POST | `/tools/:id/approve` | Aprovar ferramenta |
| POST | `/tools/:id/reject` | Rejeitar ferramenta |
| POST | `/tools/:id/sanctioned` | Marcar como sancionada |
| GET | `/findings` | Listar findings de risco |
| GET | `/findings/:id` | Detalhe do finding |
| POST | `/findings/:id/accept-risk` | Aceitar risco (note obrigatório) |
| POST | `/findings/:id/dismiss` | Dispensar finding (reason obrigatório) |
| POST | `/findings/:id/resolve` | Resolver finding |
| POST | `/findings/:id/reopen` | Reabrir finding |
| POST | `/findings/:id/promote` | Promover para catálogo |
| POST | `/findings/:id/assign-owner` | Atribuir responsável |
| GET | `/findings/:id/actions` | Histórico de ações |
| GET | `/posture` | Executive posture snapshot |
| GET | `/report` | Executive report |
| GET | `/collectors/oauth` | Listar OAuth collectors |
| POST | `/collectors/oauth` | Criar OAuth collector |
| POST | `/collectors/oauth/:id/sync` | Sincronizar OAuth |
| GET | `/collectors/google` | Listar Google collectors |
| POST | `/collectors/google` | Criar Google collector |
| POST | `/collectors/google/:id/sync` | Sincronizar Google |
| GET | `/collectors/network` | Listar Network collectors |
| POST | `/collectors/network` | Criar Network collector |
| POST | `/collectors/network/:id/ingest` | Ingerir dados de rede |
| GET | `/collectors/health` | Health de todos os collectors |
| POST | `/collectors/health/success` | Registrar sucesso de collector |
| POST | `/collectors/health/failure` | Registrar falha de collector |
| GET | `/metrics` | KPIs operacionais do Shield |
| GET | `/export/findings` | Export findings (JSON) |
| GET | `/export/findings.csv` | Export findings (CSV download) |
| GET | `/export/posture` | Export posture history (JSON) |
| GET | `/consultant/tenants/:id/shield/posture` | Postura de tenant (consultor) |
| GET | `/consultant/tenants/:id/shield/findings` | Findings de tenant (consultor) |
| GET | `/consultant/tenants/:id/shield/findings/:fid/actions` | Ações de finding (consultor) |
| GET | `/observations` | Observações brutas |

---

## Invariantes de segurança

1. **RLS sempre ativo** — `set_config('app.current_org_id', $1, false)` em toda query cross-tenant no Shield
2. **user_identifier_hash** = SHA-256(email) — nunca email plain em colunas de observação
3. **Justificativa obrigatória** — `acceptRisk` e `dismissFinding` rejeitam note/reason vazios
4. **Consultant 403** — tenant sem `consultant_assignment` nunca acessa dados via `/consultant/`
5. **set_config false** — nunca `true` em código Shield (torna a sessão inteira do pool afetada)
