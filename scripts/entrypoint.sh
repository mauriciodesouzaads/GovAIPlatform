#!/usr/bin/env bash
# ============================================================================
# GovAI Platform API — Container Entrypoint
# ============================================================================
# Runs inside the api container at startup:
#   1. Applies pending migrations   (scripts/migrate.sh)
#   2. Seeds demo data              (scripts/seed.sh)
#   3. Starts the API server        (npm start → node dist/server.js)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔══════════════════════════════════════════════════╗"
echo "║       GovAI Platform — API Container Startup     ║"
echo "╚══════════════════════════════════════════════════╝"

# Step 1 — Migrations
echo ""
echo "[1/3] Running migrations..."
bash "$SCRIPT_DIR/migrate.sh"

# Step 2 — Demo seed (idempotent, safe on every restart)
echo ""
echo "[2/3] Applying demo seed..."
bash "$SCRIPT_DIR/seed.sh"

# Step 3 — Start API
echo ""
echo "[3/3] Starting API server..."
exec npm start
