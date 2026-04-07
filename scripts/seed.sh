#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Demo Seed Runner
# ============================================================================
# Idempotent: safe to run multiple times (all inserts use ON CONFLICT DO NOTHING).
# Requires: DATABASE_URL and SIGNING_SECRET (from env or .env file).
#
# Usage (local, outside Docker):
#   ./scripts/seed.sh
#
# Usage (explicit env):
#   DATABASE_URL=postgresql://govai_app:pass@localhost:5432/govai_platform \
#     SIGNING_SECRET=... ./scripts/seed.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Load .env when SIGNING_SECRET is not already in the environment ──────────
if [ -f "$PROJECT_ROOT/.env" ] && [ -z "${SIGNING_SECRET:-}" ]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/.env"
    set +a
fi

# Inside Docker the DATABASE_URL env var is set directly; outside Docker we
# fall back to the app user + localhost.
DB_URL="${DATABASE_URL:-postgresql://govai_app:${DB_APP_PASSWORD:-govai_dev_app_password}@localhost:5432/govai_platform}"
SIGNING_SECRET="${SIGNING_SECRET:?SIGNING_SECRET must be set}"

echo "╔══════════════════════════════════════════════════╗"
echo "║       GovAI Platform — Demo Seed                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
MASKED=$(echo "$DB_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
echo "Target: $MASKED"
echo ""

# ── Step 1: Static rows (org, user, assistant) ──────────────────────────────
echo "▶ Aplicando seed.sql (org, user, assistant)..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$SCRIPT_DIR/seed.sql"
echo "  ✅ seed.sql aplicado."

# ── Step 2: Demo API key (hash depends on SIGNING_SECRET) ───────────────────
# Key value : sk-govai-demo00000000000000000000
# Prefix    : sk-govai-dem  (first 12 chars — matches server.ts substring(0,12))
# Hash algo : HMAC-SHA256(SIGNING_SECRET, JSON.stringify({key: <value>}))
DEMO_KEY="sk-govai-demo00000000000000000000"
DEMO_PREFIX="${DEMO_KEY:0:12}"   # sk-govai-dem

echo "▶ Computando hash da demo API key..."
DEMO_KEY_HASH=$(node -e "
const crypto = require('crypto');
const key = '$DEMO_KEY';
const secret = process.env.SIGNING_SECRET;
const hash = crypto.createHmac('sha256', secret).update(JSON.stringify({ key })).digest('hex');
process.stdout.write(hash);
" SIGNING_SECRET="$SIGNING_SECRET")

echo "▶ Inserindo demo API key..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
SELECT set_config('app.current_org_id', '00000000-0000-0000-0000-000000000001', true);
INSERT INTO api_keys (id, org_id, name, key_hash, prefix, is_active)
VALUES (
    '00000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'Demo Playground Key',
    '$DEMO_KEY_HASH',
    '$DEMO_PREFIX',
    true
) ON CONFLICT (id) DO NOTHING;
COMMIT;
SQL
echo "  ✅ Demo API key inserida (prefixo: $DEMO_PREFIX)."

# ── Step 3: Demo audit logs (HMAC computed via Node.js) ─────────────────────
echo "▶ Gerando audit logs demo com HMAC..."
DATABASE_URL="$DB_URL" SIGNING_SECRET="$SIGNING_SECRET" node "$SCRIPT_DIR/seed-audit-logs.js"
echo "  ✅ Audit logs inseridos."

echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ Seed aplicado com sucesso."
echo "  Login : admin@orga.com / GovAI2026@Admin"
echo "  API Key: $DEMO_KEY"
echo ""
echo "  Assistentes (chat URL base: http://localhost:3001/chat/{id}?key={api_key})"
echo "  → Assistente Jurídico:  00000000-0000-0000-0002-000000000001"
echo "  → FAQ Interno RH:       00000000-0000-0000-0002-000000000002"
echo "  → Análise de Crédito:   00000000-0000-0000-0002-000000000003"
echo "════════════════════════════════════════════════════"
