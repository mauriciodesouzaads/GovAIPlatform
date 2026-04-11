# GovAI GRC Platform — Superfície do Produto

> Gerado automaticamente em 2026-04-11 15:25 UTC

## Produtos

### 1. GOV.AI Gateway
Pipeline de execução de 9 estágios com governança integrada:
1. Auth + quota check
2. Policy snapshot (imutável)
3. DLP sanitization (configurável: mask/block/alert)
4. Jailbreak detection (OPA Engine)
5. Human-in-the-Loop (HITL approval)
6. RAG retrieval
7. MCP tool resolution + zero-trust enforcement
8. LLM execution (multi-provider via LiteLLM)
9. Audit log (HMAC-SHA256 + assinatura)

### 2. Catalog of Agents
- Lifecycle: draft → in_review → official → deprecated → archived
- Multi-track review (customizável)
- Version diff (LCS-based para prompts, field-level para policies)
- Model Cards / fichas técnicas (EU AI Act Art. 11)
- Risk Assessment wizard (25 perguntas, 5 categorias, PDF export)

### 3. Shadow AI Shield
- Detecção de uso não autorizado de IA
- KPIs de postura de segurança (25→55→68)
- Classificação por criticidade

## Módulos de Compliance

| Framework | Controles | Auto-assess |
|-----------|-----------|-------------|
| EU AI Act | 8 | 6 automáticos |
| LGPD | 7 | 5 automáticos |
| BACEN Res. 4.557 | 6 | 5 automáticos |
| ISO/IEC 42001 | 6 | 4 automáticos |
| CNJ Res. 615 | 6 | 4 automáticos |
| **Total** | **33** | **24 automáticos** |

## DLP Configurável

- 5 detectores builtin (CPF, Email, Telefone, Pessoa, Cartão de Crédito)
- Detectores custom: regex e keyword list
- 3 ações por detector: mask, block, alert
- Escopo por assistente (applies_to)
- Integração com policy exceptions

## Monitoring Contínuo

- KPIs em tempo real (60s auto-refresh)
- Alertas configuráveis (latência p95, taxa de violação, custo diário)
- Trends de 30 dias (execuções, violações, latência, custo)
- Ranking de assistentes por consumo
- Role-filtered: admin vê tudo, dpo vê governança

## Notificações

- Slack (Blocks API) + Teams (Adaptive Cards)
- 11 tipos de evento (compliance, lifecycle, técnico)
- Preview visual no frontend
- Teste de webhook integrado

## Stack Técnica

| Componente | Tecnologia |
|------------|-----------|
| API | TypeScript + Fastify |
| Database | PostgreSQL 16 + pgvector + RLS |
| Cache/Filas | Redis + BullMQ |
| Frontend | Next.js 14 + Tailwind CSS 4 |
| LLM Proxy | LiteLLM (multi-provider) |
| DLP | Presidio + spaCy PT-BR |
| Observability | Langfuse (trace hierarchy) |
| Auth | JWT + OIDC/SSO |
| Audit | HMAC-SHA256 + append-only |

## Segurança

- Row-Level Security (RLS) em todas as tabelas multi-tenant
- Audit logs imutáveis (trigger + HMAC)
- Criptografia de payloads (AES-256-GCM)
- Zero-trust MCP tool enforcement
- DLP com mascaramento automático de PII
- Policy exceptions com expiração automática

## Roles

| Role | Acesso | Redirect |
|------|--------|----------|
| admin | Tudo | / (Dashboard) |
| dpo / compliance | Governança + DLP | /shield |
| operator / sre | Técnico | / (Dashboard) |
| platform_admin | Tudo + multi-tenant | / |
