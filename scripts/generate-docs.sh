#!/bin/bash
# scripts/generate-docs.sh — Auto-gera documentação de estado do projeto
set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "📊 Gerando documentação de estado..."

# ── Contagens ──
MIGRATION_COUNT=$(ls *.sql 2>/dev/null | grep -v "^init" | wc -l | tr -d ' ')
ROUTE_FILES=$(find src/routes -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
ENDPOINTS=$(grep -rh "app\.\(get\|post\|put\|delete\|patch\)" src/routes/ 2>/dev/null | wc -l | tr -d ' ')
PAGES=$(find admin-ui/src/app -name "page.tsx" 2>/dev/null | wc -l | tr -d ' ')
WORKERS=$(find src/workers -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
SERVICES=$(find src/services -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
LIB_FILES=$(find src/lib -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
COMPONENTS=$(find admin-ui/src/components -name "*.tsx" 2>/dev/null | wc -l | tr -d ' ')
TEST_FILES=$(find . -name "*.test.ts" -o -name "*.spec.ts" 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')
DOCKER_SERVICES=$(grep -c "profiles:" docker-compose.yml 2>/dev/null || echo "0")
SEED_TABLES=$(grep -c "INSERT INTO" scripts/seed.sql 2>/dev/null || echo "0")

# ── Tabelas do banco (via migration files) ──
TABLES=$(grep -rh "CREATE TABLE" *.sql 2>/dev/null | grep -v "IF NOT EXISTS" | wc -l | tr -d ' ')
TABLES_IF=$(grep -rh "CREATE TABLE IF NOT EXISTS" *.sql 2>/dev/null | wc -l | tr -d ' ')
TOTAL_TABLES=$((TABLES + TABLES_IF))

# ── Lista de páginas ──
PAGE_LIST=$(find admin-ui/src/app -name "page.tsx" | sed "s|admin-ui/src/app||;s|/page.tsx||;s|^$|/|" | sort)

# ── Lista de rotas ──
ROUTE_LIST=$(find src/routes -name "*.ts" | sed "s|src/routes/||;s|\.ts||" | sort)

# ── Gerar CURRENT_STATE.md ──
cat > docs/CURRENT_STATE.md << EOF
# GovAI GRC Platform — Estado Atual

> Gerado automaticamente em $(date -u +"%Y-%m-%d %H:%M UTC") por \`scripts/generate-docs.sh\`

## Métricas do Projeto

| Métrica | Valor |
|---------|-------|
| Migrations | $MIGRATION_COUNT |
| Arquivos de rota | $ROUTE_FILES |
| Endpoints HTTP | ~$ENDPOINTS |
| Páginas UI | $PAGES |
| Workers BullMQ | $WORKERS |
| Services | $SERVICES |
| Libs compartilhadas | $LIB_FILES |
| Componentes React | $COMPONENTS |
| Testes automatizados | $TEST_FILES |
| Containers Docker | $DOCKER_SERVICES |
| Tabelas (migrations) | $TOTAL_TABLES |
| INSERTs no seed | $SEED_TABLES |

## Páginas da UI

\`\`\`
$PAGE_LIST
\`\`\`

## Módulos de Rota (Backend)

\`\`\`
$ROUTE_LIST
\`\`\`

## Migrations (últimas 15)

\`\`\`
$(ls *.sql 2>/dev/null | grep -v "^init" | sort | tail -15 | xargs -I{} basename {})
\`\`\`

## Containers Docker

\`\`\`
$(grep -E "^  [a-z]" docker-compose.yml | sed 's/://g' | head -10)
\`\`\`

## Versão

- Tag: $(git describe --tags --always 2>/dev/null || echo "sem tag")
- Commit: $(git rev-parse --short HEAD 2>/dev/null || echo "N/A")
- Branch: $(git branch --show-current 2>/dev/null || echo "N/A")
EOF

echo "  ✅ docs/CURRENT_STATE.md gerado"

# ── Gerar PRODUCT_SURFACE.md ──
cat > docs/PRODUCT_SURFACE.md << EOF
# GovAI GRC Platform — Superfície do Produto

> Gerado automaticamente em $(date -u +"%Y-%m-%d %H:%M UTC")

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
EOF

echo "  ✅ docs/PRODUCT_SURFACE.md gerado"
echo ""
echo "📝 Executar novamente a qualquer momento: bash scripts/generate-docs.sh"
