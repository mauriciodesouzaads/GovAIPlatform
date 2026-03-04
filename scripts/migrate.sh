#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Sequential Migration Runner
# ============================================================================
# Usage:
#   ./scripts/migrate.sh [DATABASE_URL]
#
# Applies all SQL migrations in order against the target PostgreSQL database.
# Designed for CI/CD pipelines and first-time deployments.
# ============================================================================

set -euo pipefail

DB_URL="${1:-${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/govai}}"

echo "╔══════════════════════════════════════════════════╗"
echo "║     GovAI Platform — Database Migration          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Target: $DB_URL"
echo ""

# Ordered list of migration files
MIGRATIONS=(
    "init.sql"
    "011_add_assistant_and_policy_versions.sql"
    "012_add_mcp_servers_and_grants.sql"
    "013_add_sso_and_federation.sql"
    "014_add_encrypted_runs.sql"
    "015_add_finops_billing.sql"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SUCCESS=0
FAILED=0

for migration in "${MIGRATIONS[@]}"; do
    FILEPATH="$SCRIPT_DIR/$migration"

    if [ ! -f "$FILEPATH" ]; then
        echo "⚠️  SKIP: $migration (file not found)"
        continue
    fi

    echo -n "▶ Applying $migration... "

    if psql "$DB_URL" -f "$FILEPATH" -v ON_ERROR_STOP=1 > /dev/null 2>&1; then
        echo "✅ OK"
        ((SUCCESS++))
    else
        echo "❌ FAILED"
        ((FAILED++))
        echo ""
        echo "Error applying $migration. Aborting remaining migrations."
        echo "Run manually: psql \"$DB_URL\" -f \"$FILEPATH\""
        exit 1
    fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo "  Results: $SUCCESS applied, $FAILED failed"
echo "════════════════════════════════════════════════════"

if [ "$FAILED" -eq 0 ]; then
    echo "✅ All migrations applied successfully."
else
    echo "❌ Some migrations failed. Check errors above."
    exit 1
fi
