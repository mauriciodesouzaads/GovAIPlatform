#!/usr/bin/env bash
# ============================================================================
# GovAI Platform API — Container Entrypoint
# ============================================================================
# Runs inside the api container at startup:
#   1. Applies pending migrations   (scripts/migrate.sh)
#   2. Seeds demo data conditionally (scripts/seed.sh — skips if already seeded)
#   3. Starts the API server        (npm start → node dist/server.js)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔══════════════════════════════════════════════════╗"
echo "║       GovAI Platform — API Container Startup     ║"
echo "╚══════════════════════════════════════════════════╝"

# Step 1 — Migrations (fatal: API cannot start without a migrated schema)
echo ""
echo "[1/3] Running migrations..."
bash "$SCRIPT_DIR/migrate.sh"

# Step 2 — Demo seed (conditional + non-fatal: API continues even if seed fails)
echo ""
echo "[2/3] Applying demo seed (conditional)..."
if bash "$SCRIPT_DIR/seed.sh"; then
    echo "[SEED] Seed step completed."
else
    echo "[SEED] WARNING: Seed failed — continuing API startup anyway."
    echo "[SEED] The API will work without demo data."
fi

# Step 3 — Start API
echo ""
echo "[3/3] Starting API server..."
exec npm start
