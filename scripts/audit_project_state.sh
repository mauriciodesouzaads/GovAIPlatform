#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Project State Audit + Doc Generator
# ============================================================================
# Coleta números factuais do repositório e GERA os 4 docs canônicos:
#   README.md, docs/CURRENT_STATE.md, docs/TEST_MANIFEST.md, docs/PRODUCT_SURFACE.md
#
# Uso:
#   bash scripts/audit_project_state.sh          # gera docs + relatório stdout
#   bash scripts/audit_project_state.sh --check  # só relatório, não gera docs
#
# Regras: todos os números do repositório real; nada hardcoded.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

GEN_DATE="$(date -u '+%Y-%m-%d %H:%M UTC')"
GEN_DATE_SHORT="$(date -u '+%Y-%m-%d')"
GENERATE_DOCS=true
[[ "${1:-}" == "--check" ]] && GENERATE_DOCS=false

# ── COLLECT DATA ─────────────────────────────────────────────────────────────

MIGRATION_COUNT=0
[ -f scripts/migrate.sh ] && MIGRATION_COUNT=$(grep -c '\.sql"' scripts/migrate.sh || true)
SQL_FILES=$(ls [0-9][0-9][0-9]_*.sql 2>/dev/null | sort)
FIRST_MIG=$(echo "$SQL_FILES" | head -1 | sed 's/_.*//')
LAST_MIG=$(echo "$SQL_FILES"  | tail -1 | sed 's/_.*//')

TOTAL_TEST_FILES=$(find src/__tests__ -maxdepth 1 -name "*.test.ts" -type f | wc -l | tr -d ' ')
INTEGRATION_FILES_LIST=$(grep -oE "'src/__tests__/[^*]+\.test\.ts'" vitest.config.ts 2>/dev/null | tr -d "'" | sort || true)
INTEGRATION_FILE_COUNT=$(echo "$INTEGRATION_FILES_LIST" | grep -c . || echo 0)
STANDARD_FILE_COUNT=$(( TOTAL_TEST_FILES - INTEGRATION_FILE_COUNT ))

STANDARD_TEST_COUNT="(não executado)"
if command -v npx &>/dev/null; then
    VITEST_OUT=$(DATABASE_URL='' npx vitest run 2>&1 | tail -4 || true)
    PARSED=$(echo "$VITEST_OUT" | grep -oE '[0-9]+ passed' | head -1 | awk '{print $1}' || true)
    [ -n "$PARSED" ] && STANDARD_TEST_COUNT="$PARSED"
fi

ADMIN_ROUTE_COUNT=$(grep -cE 'fastify\.(get|post|put|delete|patch)\(' src/routes/shield-admin.routes.ts 2>/dev/null || echo 0)
CONSULTANT_ROUTE_COUNT=$(grep -cE 'fastify\.(get|post|put|delete|patch)\(' src/routes/shield-consultant.routes.ts 2>/dev/null || echo 0)
SHIELD_ROUTE_COUNT=$(( ADMIN_ROUTE_COUNT + CONSULTANT_ROUTE_COUNT ))

has_file() { [ -f "$1" ] && echo "✓" || echo "✗"; }
has_dir()  { [ -d "$1" ] && echo "✓" || echo "✗"; }
D_CORE=$(has_file "src/lib/governance.ts")
D_POLICY=$(has_file "042_policy_snapshot_per_execution.sql")
D_EVIDENCE=$(has_file "src/lib/evidence.ts")
D_CATALOG=$(has_file "045_catalog_registry.sql")
D_CONSULTANT=$(has_file "src/lib/consultant-auth.ts")
D_SHIELD=$(has_file "src/lib/shield.ts")
ADMIN_UI_LOCK=$(has_file "admin-ui/package-lock.json")

ADR_LIST=$(ls docs/ADR-*.md 2>/dev/null | xargs -I{} basename {} || true)
ADR_COUNT=$(echo "$ADR_LIST" | grep -c . || echo 0)

VOLATILE_FOUND=""
for f in PROJECT_STATUS.md PROJECT_STATE.md TECHNICAL_REPORT.md AUDIT_MANIFEST.md; do
    [ -f "$f" ] && VOLATILE_FOUND="$VOLATILE_FOUND $f"
done
for f in $(ls HANDOFF*.md STATUS*.md CLEANUP*.md 2>/dev/null || true); do
    VOLATILE_FOUND="$VOLATILE_FOUND $f"
done

TSC_STATUS="✗ erro"
npx tsc --noEmit 2>/dev/null && TSC_STATUS="✓ clean"

SETCONFIG_VIOLATIONS=$(grep -rn "set_config.*true" \
    src/lib/shield*.ts src/routes/shield*.ts 2>/dev/null | grep -v "set_config.*false" || true)

# ── GENERATE DOCS ─────────────────────────────────────────────────────────────

if $GENERATE_DOCS; then

cat > README.md << HEREDOC
<!-- GENERATED — bash scripts/audit_project_state.sh — ${GEN_DATE} -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform

**Enterprise AI Governance Gateway** — controle, governança e conformidade para LLMs corporativos.

OPA Policy Engine · DLP · HITL · Multi-tenant RLS · RAG · Shield Shadow-AI Detection

---

## O que é

GovAI Platform é um gateway de governança para IA corporativa que intercepta _todas_ as requisições
aos LLMs antes de chegarem ao provedor. Pipeline determinístico: DLP semântico (Presidio) →
OPA WASM (OWASP LLM Top 10) → HITL → audit log HMAC-signed.

Multi-tenant com PostgreSQL RLS. Admin UI em Next.js 14. Shield detecta shadow-AI usage.

---

## Domínios implementados

| Domínio | Status | Módulo principal |
|---------|--------|-----------------|
| Gateway Core | ✅ | \`src/lib/governance.ts\` |
| Policy Snapshots | ✅ | \`src/lib/policy-snapshots.ts\` |
| Evidence | ✅ | \`src/lib/evidence.ts\` |
| Catalog | ✅ | \`src/lib/catalog.ts\` |
| Consultant Plane | ✅ | \`src/lib/consultant-auth.ts\` |
| Shield (shadow-AI) | ✅ | \`src/lib/shield.ts\` (facade → 5 services) |
| Architect | ✗ | não implementado |

---

## Migrations

- **Total:** ${MIGRATION_COUNT}
- **Intervalo:** ${FIRST_MIG}–${LAST_MIG} (excluindo 050)

---

## Testes

| Suíte | Arquivos | Testes |
|-------|----------|--------|
| Padrão (sem DATABASE\_URL) | ${STANDARD_FILE_COUNT} | ${STANDARD_TEST_COUNT} |
| Integração (requer DATABASE\_URL) | ${INTEGRATION_FILE_COUNT} | — |
| **Total** | **${TOTAL_TEST_FILES}** | — |

\`\`\`bash
DATABASE_URL='' npx vitest run  # suíte padrão
\`\`\`

---

## Como rodar

\`\`\`bash
npm install && cp .env.example .env
docker compose up -d
bash scripts/migrate.sh
npm run build && npm start
# Admin UI
cd admin-ui && npm ci && npm run build && npm start
\`\`\`

---

## Regenerar docs

\`\`\`bash
bash scripts/audit_project_state.sh
\`\`\`
HEREDOC

cat > docs/CURRENT_STATE.md << HEREDOC
<!-- GENERATED — bash scripts/audit_project_state.sh — ${GEN_DATE} -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Current State

**Gerado em:** ${GEN_DATE}

---

## Migrations

| Métrica | Valor |
|---------|-------|
| Total | **${MIGRATION_COUNT}** |
| Intervalo | ${FIRST_MIG}–${LAST_MIG} (excluindo 050) |
| Fonte | \`scripts/migrate.sh\` |

---

## Testes

| Métrica | Valor |
|---------|-------|
| Total de arquivos | **${TOTAL_TEST_FILES}** |
| Suíte padrão — arquivos | **${STANDARD_FILE_COUNT}** |
| Suíte padrão — testes | **${STANDARD_TEST_COUNT}** |
| Suíte integração — arquivos | **${INTEGRATION_FILE_COUNT}** |

Comando: \`DATABASE_URL='' npx vitest run\`

---

## Domínios

| Domínio | Status |
|---------|--------|
| Gateway Core | ${D_CORE} |
| Policy Snapshots | ${D_POLICY} |
| Evidence | ${D_EVIDENCE} |
| Catalog | ${D_CATALOG} |
| Consultant Plane | ${D_CONSULTANT} |
| Shield | ${D_SHIELD} |
| Architect | ✗ não implementado |

---

## Shield API Routes

| Módulo | Rotas |
|--------|-------|
| Admin (\`/v1/admin/shield/*\`) | ${ADMIN_ROUTE_COUNT} |
| Consultant (\`/v1/consultant/tenants/*/shield/*\`) | ${CONSULTANT_ROUTE_COUNT} |
| **Total** | **${SHIELD_ROUTE_COUNT}** |

---

## Build

| Check | Status |
|-------|--------|
| tsc --noEmit | ${TSC_STATUS} |
| Admin UI lockfile | ${ADMIN_UI_LOCK} |

---

## ADRs (${ADR_COUNT})

$(echo "$ADR_LIST" | sed 's/^/- /')

---

## Limitações

- BullMQ workers: não implementados (coleta admin-triggered)
- SSE / browser extension: ver ADR-004
- Architect domain: roadmap futuro
HEREDOC

INTEGRATION_LIST_MD=$(echo "$INTEGRATION_FILES_LIST" | sed 's|src/__tests__/|- `|' | sed 's/$/.`/')

cat > docs/TEST_MANIFEST.md << HEREDOC
<!-- GENERATED — bash scripts/audit_project_state.sh — ${GEN_DATE} -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Test Manifest

**Gerado em:** ${GEN_DATE}

---

## Contagem

| Métrica | Valor |
|---------|-------|
| Total de arquivos de teste | **${TOTAL_TEST_FILES}** |
| Suíte padrão — arquivos | **${STANDARD_FILE_COUNT}** |
| Suíte padrão — testes | **${STANDARD_TEST_COUNT}** |
| Suíte integração — arquivos | **${INTEGRATION_FILE_COUNT}** |

---

## Comandos

\`\`\`bash
# Suíte padrão (sem banco)
DATABASE_URL='' npx vitest run

# Suíte integração (requer PostgreSQL)
DATABASE_URL=postgresql://user:pass@localhost:5432/dbname npx vitest run

# Migrations clean test
bash scripts/test-migrations-clean.sh
\`\`\`

---

## Arquivos de integração (${INTEGRATION_FILE_COUNT} — requerem DATABASE_URL)

${INTEGRATION_LIST_MD}

---

## Suíte padrão

${STANDARD_FILE_COUNT} arquivos em \`src/__tests__/\` não listados acima.
Inclui: auth, HITL, DLP, OPA, FinOps, RAG, API Keys, Orgs, policy, evidence, catalog,
Shield unit tests, risk engine unit tests.

Não requer serviços externos. Roda em CI puro.
HEREDOC

cat > docs/PRODUCT_SURFACE.md << HEREDOC
<!-- GENERATED — bash scripts/audit_project_state.sh — ${GEN_DATE} -->
<!-- Não editar manualmente. Regenerar após cada sprint. -->

# GovAI Platform — Product Surface

**Gerado em:** ${GEN_DATE}

---

## Gateway Core

- \`POST /v1/execute/:id\` — execução de assistente com pipeline completo
- \`GET  /v1/health\` — health check
- Auth: JWT Bearer + API Key (\`sk-govai-...\`)
- DLP: Presidio NLP + regex
- OPA WASM: OWASP LLM Top 10 (LLM01–LLM10)
- HITL: aprovação humana
- Audit log: HMAC-SHA256 signed
- FinOps: tokens/custo por org

## Policy

- \`GET/POST /v1/admin/policies\`
- \`GET/POST /v1/admin/policy-snapshots\`
- \`GET/POST /v1/admin/policy-exceptions\`

## Evidence

- \`GET/POST /v1/admin/evidence\`

## Catalog

- \`GET/POST /v1/admin/catalog\`
- Lifecycle: draft → review → approved → deprecated

## Consultant Plane

- \`GET /v1/consultant/tenants/:tenantOrgId/*\`
- Shield: ${CONSULTANT_ROUTE_COUNT} rotas (posture, findings, actions)

## Shield — Shadow-AI Detection (${SHIELD_ROUTE_COUNT} rotas total)

**Admin (${ADMIN_ROUTE_COUNT} rotas):**

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

- Architect domain
- BullMQ workers (coleta automática)
- SSE / browser extension (ADR-004)
- CASB integration

---

## Admin UI (Next.js 14)

Dashboard · Fila HITL · Playground · RAG Upload · Relatórios compliance
HEREDOC

fi  # end GENERATE_DOCS

# ── STDOUT REPORT ─────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     GovAI Platform — Project State Audit                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Generated: $GEN_DATE"
$GENERATE_DOCS && echo "Mode: GENERATE (docs written)" || echo "Mode: CHECK"
echo ""

echo "━━━ MIGRATIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Total:      $MIGRATION_COUNT  ($FIRST_MIG – $LAST_MIG, excl. 050)"
echo ""

echo "━━━ TESTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Total files:      $TOTAL_TEST_FILES"
echo "  Standard files:   $STANDARD_FILE_COUNT"
echo "  Standard tests:   $STANDARD_TEST_COUNT"
echo "  Integration:      $INTEGRATION_FILE_COUNT files"
echo ""

echo "━━━ SHIELD ROUTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Admin:       $ADMIN_ROUTE_COUNT"
echo "  Consultant:  $CONSULTANT_ROUTE_COUNT"
echo "  Total:       $SHIELD_ROUTE_COUNT"
echo ""

echo "━━━ DOMAINS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $D_CORE  Gateway Core"
echo "  $D_POLICY  Policy"
echo "  $D_EVIDENCE  Evidence"
echo "  $D_CATALOG  Catalog"
echo "  $D_CONSULTANT  Consultant Plane"
echo "  $D_SHIELD  Shield"
echo "  ✗  Architect (not implemented)"
echo ""

echo "━━━ ADRs ($ADR_COUNT) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for adr in $ADR_LIST; do echo "  $adr"; done
echo ""

echo "━━━ BUILD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  tsc --noEmit:   $TSC_STATUS"
echo "  Admin UI lock:  $ADMIN_UI_LOCK"
echo ""

echo "━━━ SECURITY (Shield files) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -z "$SETCONFIG_VIOLATIONS" ]; then
    echo "  set_config(..., true): ✓ 0 ocorrências"
else
    echo "  ATENÇÃO — set_config(..., true) encontrado:"
    echo "$SETCONFIG_VIOLATIONS" | sed 's/^/    /'
fi
echo ""

echo "━━━ VOLATILE DOCS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -z "$VOLATILE_FOUND" ]; then
    echo "  ✓ Nenhum doc volátil encontrado"
else
    for v in $VOLATILE_FOUND; do echo "  ⚠ $v"; done
fi
echo ""

echo "━━━ CANONICAL DOCS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for doc in README.md docs/CURRENT_STATE.md docs/TEST_MANIFEST.md docs/PRODUCT_SURFACE.md; do
    if [ -f "$doc" ]; then echo "  ✓ $doc"
    else echo "  ✗ $doc (ausente)"; fi
done
echo ""

$GENERATE_DOCS && echo "✓ Docs gerados: $GEN_DATE" || true
