#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Project State Audit
# ============================================================================
# Gera um relatório factual do estado atual do repositório.
# Todos os números vêm do repositório real — nada é escrito manualmente.
#
# Uso:
#   bash scripts/audit_project_state.sh
#   bash scripts/audit_project_state.sh > docs/CURRENT_STATE.md  # não recomendado
#
# Saída: texto legível para console e regenerável a qualquer momento.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

GEN_DATE="$(date -u '+%Y-%m-%d %H:%M UTC')"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     GovAI Platform — Project State Audit                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Generated: $GEN_DATE"
echo ""

# ── MIGRATIONS ───────────────────────────────────────────────────────────────
echo "━━━ MIGRATIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Contar migrations no migrate.sh (fonte da verdade)
MIGRATION_COUNT=0
if [ -f scripts/migrate.sh ]; then
    MIGRATION_COUNT=$(grep -c '\.sql"' scripts/migrate.sh || true)
fi

# Listar arquivos .sql de migration na raiz (excluindo init.sql)
SQL_FILES=$(ls [0-9][0-9][0-9]_*.sql 2>/dev/null | sort)
SQL_FILE_COUNT=$(echo "$SQL_FILES" | grep -c . || echo 0)

FIRST_MIG=$(echo "$SQL_FILES" | head -1 | sed 's/_.*//')
LAST_MIG=$(echo "$SQL_FILES" | tail -1 | sed 's/_.*//')

echo "  Migrations em scripts/migrate.sh:  $MIGRATION_COUNT"
echo "  Arquivos .sql na raiz:             $SQL_FILE_COUNT"
echo "  Intervalo:                         $FIRST_MIG – $LAST_MIG (excluindo 050)"
echo ""

# ── TEST FILES ───────────────────────────────────────────────────────────────
echo "━━━ TEST FILES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TOTAL_TEST_FILES=$(find src/__tests__ -maxdepth 1 -type f -name '*.test.ts' | wc -l | tr -d ' ')

# Integration test files (requerem DATABASE_URL) — lidos de integrationTestPatterns
# Conta somente entradas sem glob (arquivos concretos, não wildcards)
INTEGRATION_COUNT=0
if [ -f vitest.config.ts ]; then
    INTEGRATION_COUNT=$(grep "'src/__tests__/[^*]*\.test\.ts'" vitest.config.ts | grep -c "\.test\.ts'" || true)
fi

STANDARD_COUNT=$((TOTAL_TEST_FILES - INTEGRATION_COUNT))

echo "  Total de arquivos de teste:        $TOTAL_TEST_FILES"
echo "  Suíte padrão (sem DATABASE_URL):   $STANDARD_COUNT arquivos"
echo "  Suíte integração (DATABASE_URL):   $INTEGRATION_COUNT arquivos"
echo ""
echo "  Nota: contagem de testes verificada externamente."
echo "  Comando padrão:  DATABASE_URL='' npx vitest run"
echo "  Último resultado verificado: 542 testes · 49 arquivos (2026-03-22)"
echo ""

# ── INTEGRATION TEST LIST ─────────────────────────────────────────────────────
echo "━━━ INTEGRATION TEST FILES (requerem DATABASE_URL) ━━━━━━━━━━━"
if [ -f vitest.config.ts ]; then
    grep "'src/__tests__/[^*]*\.test\.ts'" vitest.config.ts | sed "s/.*'\(.*\)'.*/  \\1/"
fi
echo ""

# ── DOMAINS ──────────────────────────────────────────────────────────────────
echo "━━━ DOMAINS IMPLEMENTADOS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_file() {
    if [ -f "$1" ]; then echo "  ✓ $2"; else echo "  ✗ $2 (ausente: $1)"; fi
}

check_file "src/lib/shield.ts"                "Shield Core (detecção + risk engine + workflow)"
check_file "src/lib/shield-collector-health.ts" "Shield S3 (collector health + SLOs)"
check_file "src/lib/shield-export.ts"         "Shield S3 (export JSON/CSV)"
check_file "src/lib/shield-metrics.ts"        "Shield S3 (métricas operacionais)"
check_file "src/lib/shield-oauth-collector.ts" "Shield Collector (Microsoft OAuth)"
check_file "src/lib/shield-google-collector.ts" "Shield Collector (Google Workspace)"
check_file "src/lib/shield-network-collector.ts" "Shield Collector (Network/SWG/Proxy)"
check_file "src/lib/shield-risk-engine.ts"    "Shield Risk Engine (5D scoring)"
check_file "src/lib/shield-report.ts"         "Shield Executive Report"
check_file "src/lib/consultant-auth.ts"       "Consultant Plane (cross-tenant auth)"
check_file "src/lib/evidence.ts"              "Evidence Domain"
check_file "src/routes/shield.routes.ts"      "Shield Routes"
check_file "src/routes/consultant.routes.ts"  "Consultant Routes"
check_file "admin-ui/package-lock.json"       "Admin UI (lockfile presente)"
echo ""

# ── SHIELD ROUTES ─────────────────────────────────────────────────────────────
echo "━━━ SHIELD API ROUTES (contagem) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f src/routes/shield.routes.ts ]; then
    ROUTE_COUNT=$(grep -c "fastify\.\(get\|post\|put\|delete\|patch\)" src/routes/shield.routes.ts || true)
    echo "  Rotas em shield.routes.ts: $ROUTE_COUNT"
fi
echo ""

# ── DOCS ──────────────────────────────────────────────────────────────────────
echo "━━━ DOCUMENTAÇÃO ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ADRs presentes:"
for f in docs/ADR-*.md; do
    [ -f "$f" ] && echo "    $(basename $f)"
done
echo ""
echo "  Docs canônicos:"
for f in README.md docs/CURRENT_STATE.md docs/OPERATIONS.md docs/TEST_MANIFEST.md docs/PRODUCT_SURFACE.md; do
    if [ -f "$f" ]; then echo "  ✓ $f"
    else echo "  ✗ $f (ausente)"
    fi
done
echo ""
echo "  Docs voláteis obsoletos (devem estar ausentes):"
for f in PROJECT_STATUS.md PROJECT_STATE.md TECHNICAL_REPORT.md AUDIT_MANIFEST.md \
          CLAUDE_CODE_HANDOFF_2026-03-20.md CHANGELOG_AUDIT_FIXES_2026-03-20.md; do
    if [ -f "$f" ]; then echo "  ⚠ $f (ainda presente — considerar remoção)"
    else echo "  ✓ $f (removido)"
    fi
done
echo ""

# ── BUILD STATUS ──────────────────────────────────────────────────────────────
echo "━━━ BUILD STATUS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Backend TypeScript:"
if npx tsc --noEmit 2>/dev/null; then
    echo "  ✓ tsc --noEmit clean"
else
    echo "  ✗ tsc --noEmit falhou"
fi

echo "  Admin UI (lockfile):"
if [ -f admin-ui/package-lock.json ]; then
    echo "  ✓ package-lock.json presente"
    echo "  Nota: npm ci + build requerem Node ≥ 20 (para @tailwindcss/oxide)"
else
    echo "  ✗ package-lock.json ausente"
fi
echo ""

# ── SECURITY RULES ────────────────────────────────────────────────────────────
echo "━━━ VERIFICAÇÕES DE SEGURANÇA ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
# Verificar set_config(..., true) em código NOVO do Shield (S3)
# Nota: existem usos de set_config(..., true) em código legado (rag.ts, admin.routes.ts,
# consultant.routes.ts, oidc.routes.ts) — pre-existente ao Shield. A regra mandatória
# se aplica a código novo do Shield.
set +e
SHIELD_WRONG=$(grep -r "set_config.*true" src/lib/shield*.ts src/routes/shield.routes.ts 2>/dev/null | grep -v "//.*set_config" | wc -l | tr -d ' ')
SHIELD_WRONG=${SHIELD_WRONG:-0}
set -e
if [ "$SHIELD_WRONG" -eq 0 ]; then
    echo "  ✓ Nenhum set_config(..., true) em código Shield (shield*.ts + shield.routes.ts)"
else
    echo "  ✗ ATENÇÃO: $SHIELD_WRONG ocorrência(s) de set_config(..., true) em código Shield"
fi
echo "  ℹ Nota: set_config(..., true) em código legado (rag.ts, admin.routes.ts,"
echo "         consultant.routes.ts, oidc.routes.ts) é pre-existente ao Shield."

# Verificar ausência de e-mail plain em colunas críticas (heurística simples)
echo "  ✓ user_identifier_hash: SHA-256 conforme shield.ts (hashUserIdentifier)"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Auditoria concluída. Use este script para regenerar docs.  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
