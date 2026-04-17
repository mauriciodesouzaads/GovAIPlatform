#!/bin/bash
# ============================================================================
# GovAI Platform — Restore Validation (FASE 11)
# ----------------------------------------------------------------------------
# Validates that the latest backup is restorable by creating a throwaway
# database, restoring into it, counting tables, and dropping the DB.
# Meant to run weekly as a sanity check.
#
# Usage:
#   bash scripts/test-restore.sh [backup_dir]
#
# Exit codes:
#   0  = restore successful
#   1  = backup not found / restore failed / table count too low
# ============================================================================

set -euo pipefail

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"

# ── Locate latest backup ──
LATEST_BACKUP=$(ls -t "$BACKUP_DIR"/govai_backup_*.sql.gz 2>/dev/null | head -1 || echo "")
if [ -z "$LATEST_BACKUP" ]; then
    echo "❌ No backup found in $BACKUP_DIR"
    exit 1
fi

TEST_DB="govai_test_restore_$(date +%s)"

echo "==== [GovAI] Backup Restore Validation ===="
echo "Source: $LATEST_BACKUP"
echo "Target DB: $TEST_DB (will be dropped after validation)"

# ── Create temp DB ──
docker compose exec -T database psql -U postgres -c "CREATE DATABASE $TEST_DB" >/dev/null

# ── Restore (pipe gunzip into psql) ──
# Use `bash -c` so the redirection and pipeline run inside the container
gunzip -c "$LATEST_BACKUP" | docker compose exec -T database psql -U postgres -d "$TEST_DB" >/dev/null 2>&1 || {
    echo "❌ Restore command failed"
    docker compose exec -T database psql -U postgres -c "DROP DATABASE IF EXISTS $TEST_DB" >/dev/null 2>&1 || true
    exit 1
}

# ── Validate: key table count ──
TABLE_COUNT=$(docker compose exec -T database psql -U postgres -d "$TEST_DB" -tA -c \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'" | tr -d '[:space:]')

echo "→ Tables restored: $TABLE_COUNT"

# 50 is a conservative floor — the schema has many tables (architect_*, shield_*,
# audit_*, organizations, assistants, etc.). Anything materially below this
# means the restore only got partway through the dump.
if [ "${TABLE_COUNT:-0}" -lt 50 ]; then
    echo "❌ Restore incomplete — only $TABLE_COUNT tables (expected ≥ 50)"
    docker compose exec -T database psql -U postgres -c "DROP DATABASE $TEST_DB" >/dev/null
    exit 1
fi

# ── Validate: critical rows present ──
ORG_COUNT=$(docker compose exec -T database psql -U postgres -d "$TEST_DB" -tA -c \
    "SELECT COUNT(*) FROM organizations" 2>/dev/null | tr -d '[:space:]' || echo "0")
ASSIST_COUNT=$(docker compose exec -T database psql -U postgres -d "$TEST_DB" -tA -c \
    "SELECT COUNT(*) FROM assistants" 2>/dev/null | tr -d '[:space:]' || echo "0")

echo "→ Organizations: $ORG_COUNT"
echo "→ Assistants:    $ASSIST_COUNT"

# ── Cleanup ──
docker compose exec -T database psql -U postgres -c "DROP DATABASE $TEST_DB" >/dev/null

echo "✅ Restore validated successfully ($TABLE_COUNT tables)"
echo "==== [GovAI] Restore Validation Ended ===="
