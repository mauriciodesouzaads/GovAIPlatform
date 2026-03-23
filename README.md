<div align="center">

<img src="https://img.shields.io/badge/GovAI-Platform-00ff88?style=for-the-badge&logo=shield&logoColor=black" />
<img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript" />
<img src="https://img.shields.io/badge/Next.js-14-black?style=for-the-badge&logo=next.js" />
<img src="https://img.shields.io/badge/PostgreSQL-15-336791?style=for-the-badge&logo=postgresql" />
<img src="https://img.shields.io/badge/OPA-WASM-7B42BC?style=for-the-badge" />
<img src="https://img.shields.io/badge/Groq-llama--3.3--70b-orange?style=for-the-badge" />

<br/><br/>

<img src="https://img.shields.io/badge/tests-542_passing_%2B_14_integration_suites-00ff88?style=flat-square" />
<img src="https://img.shields.io/badge/coverage-81%25-00ff88?style=flat-square" />
<img src="https://img.shields.io/badge/CI%2FCD-passing-00ff88?style=flat-square" />
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />

<h1>GovAI Platform</h1>

<p>
  <strong>Enterprise AI Governance Gateway</strong><br/>
  Controle, governança e conformidade para LLMs corporativos.<br/>
  OPA Policy Engine · DLP · HITL · Multi-tenant RLS · RAG
</p>

</div>

---

## O que é o GovAI Platform

**GovAI Platform** é um gateway de governança para IA corporativa que intercepta _todas_ as requisições aos LLMs antes de chegarem ao provedor. Toda mensagem passa por um pipeline determinístico de segurança: detecção de PII com DLP semântico (Presidio + regex), avaliação de políticas com OPA WASM (OWASP LLM Top 10), roteamento para aprovação humana (HITL) quando necessário, e registro criptograficamente assinado para conformidade LGPD/GDPR.

Diferente de soluções que aplicam filtros superficiais, o GovAI opera no nível de infraestrutura: os LLMs nunca recebem prompts não sanitizados. Cada execução gera um audit log HMAC-signed imutável, rastreável por Trace ID, com verificação de assinatura disponível no relatório de compliance.

A plataforma é **multi-tenant** desde o início — Row-Level Security no PostgreSQL garante isolamento por organização sem camadas adicionais de filtro na aplicação. Um único deploy serve múltiplos tenants de forma segura, com rotação automática de API Keys (TTL 90 dias), suporte a SSO/OIDC (Microsoft Entra ID, Okta) e rastreamento FinOps por token/custo por organização.

O Admin UI (Next.js 14) oferece visibilidade completa: dashboard em tempo real, fila HITL de aprovação/rejeição, playground para testar o pipeline de governança, upload de knowledge bases (RAG), e relatórios de compliance exportáveis em PDF/CSV.

---

## Arquitetura

```mermaid
graph TD
    Client["Cliente / App\n(API Key sk-govai-...)"] -->|POST /v1/execute/:id| Gateway

    subgraph Gateway["GovAI Gateway — Fastify + TypeScript :3000"]
        Auth["🔐 Auth\nJWT · API Key · OIDC"]
        RL["⏱ Rate Limiter\nRedis sliding window"]
        DLP["🔍 DLP Engine\nPresidio NLP + Regex\nCPF · CNPJ · PIX · email"]
        OPA["🛡 OPA WASM\nOWASP LLM Top 10\nLLM01–LLM10 · 144 testes"]
        HITL{"👤 HITL\nRequired?"}
        LLM["🧠 LiteLLM Proxy\nGroq · OpenAI · Anthropic"]
    end

    subgraph Workers["Workers — BullMQ / Redis"]
        AQ["📝 Audit Queue\nHMAC-SHA256 signed"]
        TQ["📡 Telemetry Queue\nLangfuse export"]
        EW["⏰ Expiration Worker\n48h TTL"]
    end

    subgraph Data["Data Layer"]
        PG[("🐘 PostgreSQL 15\npgvector + RLS")]
        RD[("⚡ Redis 7")]
        PRES["🧬 Presidio\nspaCy PT-BR"]
    end

    Admin["Admin UI — Next.js :3001\nDashboard · HITL · Playground · Reports"] -->|JWT| Gateway

    Auth --> RL --> DLP --> OPA --> HITL
    DLP -.->|NLP scan| PRES
    HITL -->|No violation| LLM
    HITL -->|High risk| AQ
    OPA -->|Violation| Block["🚫 403 BLOCKED"]
    LLM --> AQ
    AQ --> PG
    AQ --> TQ
    TQ --> RD
    EW --> PG
    RL --> RD
    LLM -->|Response| Client
```

---

## Pipeline de Governança

```mermaid
sequenceDiagram
    participant C as Cliente
    participant G as GovAI Gateway
    participant D as DLP Engine
    participant O as OPA WASM
    participant H as HITL Queue
    participant L as LLM Provider
    participant DB as Audit Log

    C->>G: POST /v1/execute/:assistantId<br/>{message: "..."}
    G->>D: Scan PII (CPF, CNPJ, email, cartão)
    D-->>G: safeMessage (masked/redacted)
    G->>O: Evaluate policy(safeMessage, assistant)
    alt Prompt Injection / LLM01-LLM10 detectado
        O-->>G: BLOCK
        G->>DB: Persist POLICY_VIOLATION (HMAC signed)
        G-->>C: 403 {"error": "Policy violation", traceId}
    else Alto risco — keyword financeira/HITL trigger
        O-->>G: PENDING_APPROVAL
        G->>H: Enqueue for human review (48h TTL)
        G->>DB: Persist PENDING_APPROVAL (HMAC signed)
        G-->>C: 202 {"status": "pending_approval", approvalId}
    else Request limpo
        O-->>G: ALLOW
        G->>L: POST /chat/completions (safeMessage)
        L-->>G: AI Response + usage tokens
        G->>DB: Persist EXECUTION_SUCCESS (HMAC signed)
        G-->>C: 200 {"response": "...", traceId, _govai}
    end
```

---

## Features

| Feature | Descrição | Status |
|---|---|---|
| 🛡️ **OPA Policy Engine** | WASM-compiled Rego policies, OWASP LLM Top 10 (LLM01–LLM10), 144 testes | ✅ |
| 🔍 **DLP Scanner** | Presidio NLP (spaCy PT-BR) + Regex (CPF, CNPJ, PIX, cartão, email) | ✅ |
| 👤 **HITL Approval** | Human-in-the-Loop com fila BullMQ, 48h TTL, approve/reject no Admin UI | ✅ |
| 🏢 **Multi-tenant RLS** | Isolamento por `org_id` com PostgreSQL Row-Level Security, bypass via `platform_admin` | ✅ |
| 🔑 **API Key Management** | Rotação automática TTL 90 dias, hash bcrypt, prefix indexing | ✅ |
| 📚 **RAG Knowledge Base** | pgvector 768 dims, text chunking, cosine similarity search, token budget | ✅ |
| 📋 **Audit Logs** | HMAC-SHA256 signed, imutáveis, verificação de integridade, LGPD/GDPR ready | ✅ |
| 🤖 **LLM Agnostic** | Groq llama-3.3-70b-versatile, OpenAI, Anthropic e qualquer provedor via LiteLLM proxy | ✅ |
| 🔐 **SSO / OIDC** | Microsoft Entra ID, Okta, qualquer IdP OIDC; JIT provisioning | ✅ |
| 💰 **FinOps** | Token tracking, cost estimation por org, FinOps ledger por execução | ✅ |
| 📊 **Observabilidade** | Prometheus `/metrics`, Grafana dashboards, Langfuse, AlertManager SMTP/Slack | ✅ |
| 🔒 **BYOK Encryption** | AES-256-GCM envelope encryption com Org Master Key, Crypto-Shredding | ✅ |
| 🧪 **Playwright E2E** | 5 testes end-to-end: login, dashboard, assistants, playground, HITL | ✅ |
| 🚀 **CI/CD Pipeline** | 6 jobs: lint, unit tests, integration tests, security scan, docker build, deploy | ✅ |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/mauriciodesouzaads/GovAIPlatform.git
cd GovAIPlatform

# 2. Configure
cp .env.example .env
# Edite .env — mínimo: GROQ_API_KEY, DB_PASSWORD, DB_APP_PASSWORD,
# REDIS_PASSWORD, SIGNING_SECRET, JWT_SECRET, ORG_MASTER_KEY

# 3. Inicie o stack completo (6 containers)
docker compose up -d

# 4. Aplique as migrations
DATABASE_URL=postgresql://postgres:govai_dev_db_password@localhost:5432/govai_platform \
  bash scripts/migrate.sh

# 5. Acesso
# Admin UI:  http://localhost:3001  (admin@orga.com / GovAI2026@Admin)
# API:       http://localhost:3000
# Login curl:
curl -s -X POST http://localhost:3000/v1/admin/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | python3 -m json.tool
```

---

## Stack Técnica

| **Backend** | **Frontend** | **Infra** |
|---|---|---|
| Fastify 5 + TypeScript strict | Next.js 14 App Router | Docker Compose (6 serviços) |
| PostgreSQL 15 + pgvector | Tailwind CSS v4 | Redis 7 + BullMQ |
| OPA WASM (Rego policies) | Recharts (dashboards) | LiteLLM proxy |
| Presidio NLP (Python/FastAPI) | Lucide Icons | Prometheus + Grafana |
| Vitest (542 padrão · 49 arquivos + 14 integration suites) | TypeScript strict | AlertManager (SMTP + Slack) |
| Playwright E2E (5 testes) | Playwright E2E | Nginx (reverse proxy) |
| Zod validation (todos endpoints) | Axios + SWR | GitHub Actions CI/CD |

---

## Estrutura do Repositório

```text
govai-platform/
├── src/                         # Backend (Fastify + TypeScript)
│   ├── server.ts                # Orquestrador principal
│   ├── routes/                  # Endpoints REST
│   │   ├── admin.routes.ts      # Auth, API Keys, Orgs, Knowledge, Stats
│   │   ├── assistants.routes.ts # Assistants CRUD + versioning
│   │   ├── approvals.routes.ts  # HITL approve/reject
│   │   └── reports.routes.ts    # Compliance PDF/CSV
│   ├── services/
│   │   └── execution.service.ts # Pipeline DLP → OPA → LLM → Audit
│   ├── lib/                     # Motores de governança
│   │   ├── opa-governance.ts    # OPA WASM + 4 stages
│   │   ├── dlp-engine.ts        # PII detection + Presidio hook
│   │   ├── rag.ts               # pgvector chunks + cosine search
│   │   ├── crypto-service.ts    # AES-256-GCM BYOK
│   │   ├── finops.ts            # Token ledger + cost tracking
│   │   └── governance.ts        # HMAC signing + audit
│   ├── workers/                 # BullMQ async processors
│   │   ├── audit.worker.ts      # Persist HMAC-signed logs
│   │   ├── telemetry.worker.ts  # Langfuse export
│   │   └── expiration.worker.ts # 48h HITL TTL
│   └── __tests__/               # 63 arquivos: 542 testes padrão (49 arq) + 14 suítes integração
├── admin-ui/                    # Frontend (Next.js 14)
│   ├── src/app/
│   │   ├── page.tsx             # Dashboard + métricas
│   │   ├── assistants/          # CRUD + RAG upload
│   │   ├── approvals/           # Fila HITL
│   │   ├── playground/          # Teste do pipeline
│   │   ├── reports/             # Compliance PDF/CSV
│   │   └── logs/                # Audit logs paginados
│   └── e2e/                     # Playwright testes
├── presidio/                    # Microserviço NLP (Python/FastAPI)
├── deploy/                      # Artefatos de deploy
│   ├── vps.sh                   # Script Ubuntu 22.04
│   ├── nginx.conf               # Reverse proxy HTTPS
│   └── README.md                # Guias VPS / AWS / GCP / Render
├── scripts/
│   ├── migrate.sh               # Aplicar migrations em ordem
│   ├── init-roles.sh            # Criar roles PostgreSQL
│   └── demo-seed.sh             # Seed de demonstração
├── docker-compose.yml           # Dev stack (6 serviços)
├── docker-compose.prod.yml      # Prod stack (govai-prod-net, resource limits)
├── litellm-config.yaml          # LiteLLM proxy config (Groq llama-3.3-70b-versatile)
├── .env.example                 # Template de variáveis de dev
├── .env.prod.example            # Template de variáveis de produção
└── 011–053_*.sql                # Migrations numeradas (42 total, excl. 050)
```

---

## API Reference

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| `POST` | `/v1/execute/:assistantId` | Execução com pipeline completo (DLP → OPA → LLM) |
| `POST` | `/v1/admin/login` | Autenticação JWT (rate limit: 10 req/15min) |
| `GET` | `/v1/admin/stats` | Métricas em tempo real (executions, violations, tokens) |
| `GET` | `/v1/admin/assistants` | Listar assistentes da organização |
| `POST` | `/v1/admin/assistants` | Criar assistente com policy + MCP server |
| `POST` | `/v1/admin/assistants/:id/versions` | Criar versão com policy JSON |
| `GET` | `/v1/admin/approvals` | Fila HITL pendente |
| `POST` | `/v1/admin/approvals/:id/approve` | Aprovar e re-executar |
| `POST` | `/v1/admin/approvals/:id/reject` | Rejeitar com motivo |
| `POST` | `/v1/admin/api-keys` | Criar API Key (`sk-govai-...`) |
| `GET` | `/v1/admin/audit-logs` | Logs de auditoria paginados |
| `GET` | `/v1/admin/reports/compliance` | Relatório de compliance (JSON/PDF/CSV) |
| `POST` | `/v1/admin/assistants/:id/knowledge` | Criar knowledge base (RAG) |
| `POST` | `/v1/admin/knowledge/:kbId/documents` | Ingerir documento (chunk + embed) |
| `GET` | `/health` | Health check (db + redis status) |
| `GET` | `/metrics` | Prometheus metrics (requer `METRICS_API_KEY`) |

---

## Deployment

```bash
# ── VPS Ubuntu 22.04 (recomendado para até ~500 usuários) ──
REPO_URL=https://github.com/mauriciodesouzaads/GovAIPlatform.git \
  sudo bash deploy/vps.sh

# ── Docker Compose Produção ──
cp .env.prod.example .env.prod
# Preencha todos os valores — veja instruções de geração no arquivo
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d

# ── AWS ECS / Google Cloud Run / Render.com ──
# Ver deploy/README.md para guias detalhados de cada plataforma
```

**GitHub Actions deploy automático** (push para `main`):
1. Configure `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` nos GitHub Secrets
2. O job `deploy` no CI/CD executará `vps.sh` via SSH automaticamente
3. Health check pós-deploy verifica `/health` antes de marcar o job como bem-sucedido

---

## Segurança

- **Multi-tenant RLS** — PostgreSQL Row-Level Security por `org_id`; `platform_admin` com `BYPASSRLS` para workers cross-tenant, sempre em bloco `try/finally` com `RESET ROLE`
- **API Keys** — hash bcrypt, prefix indexing, rotação automática TTL 90 dias via BullMQ cron
- **JWT + OIDC SSO** — tokens assinados com `JWT_SECRET` ≥ 32 chars; suporte a Microsoft Entra ID e Okta
- **Helmet** — CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options
- **Rate limiting granular** — login: 10 req/15min, execute: 100 req/1min, por IP
- **Secret scanning** — Gitleaks no CI em todo push/PR para `main`
- **Trivy** — scan de vulnerabilidades no Dockerfile (CRITICAL/HIGH bloqueiam o CI)
- **Audit logs imutáveis** — HMAC-SHA256 com `SIGNING_SECRET`, verificação de integridade no relatório de compliance
- **BYOK encryption** — AES-256-GCM envelope com Org Master Key, Crypto-Shredding suportado
- **Zod validation** — `safeParse` em todos os endpoints antes de processar input
- **SQL parametrizado** — queries com `$1, $2...`, sem interpolação de string em nenhum lugar

---

## Testes

```bash
# Suíte padrão — 542 testes · 49 arquivos (sem banco)
DATABASE_URL='' npx vitest run

# Suíte de integração — 14 suítes com banco PostgreSQL real
DATABASE_URL=postgresql://postgres:GovAI2026@Admin@localhost:5432/govai_platform npx vitest run

# TypeScript strict (zero erros)
npx tsc --noEmit

# Admin UI — build (zero erros TS, requer Node ≥ 20)
cd admin-ui && npm ci && npm run build

# Auditoria do estado do repositório (regenera números canônicos)
bash scripts/audit_project_state.sh

# E2E Playwright (requer stack rodando em :3000 e :3001)
cd admin-ui && npx playwright test
```

---

## Contributing

Contribuições são bem-vindas. Antes de abrir um PR:

1. `DATABASE_URL='' npx vitest run` — todos os 542 testes padrão devem passar
2. `npx tsc --noEmit` — zero erros TypeScript strict
3. `npm audit --audit-level=high` — sem vulnerabilidades high/critical
4. Nenhum secret hardcoded (Gitleaks verifica no CI)
5. Queries SQL sempre parametrizadas (`$1, $2...`)

---

## Autor

**Maurício de Souza**
Senior Software Architect | AI Governance & Cloud Security
[GitHub](https://github.com/mauriciodesouzaads)

---

*License: MIT*
