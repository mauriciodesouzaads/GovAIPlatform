#!/bin/bash
# ============================================================================
# GovAI Platform — Automated Backup Script (FASE 11 hardening)
# ----------------------------------------------------------------------------
# Daily pg_dump of govai_platform with gzip, file-size validation, and
# retention rotation. Usage:
#
#   bash scripts/backup-db.sh [backup_dir]
#
# For cron:
#   0 2 * * * cd /path/to/govai && bash scripts/backup-db.sh >> /var/log/govai-backup.log 2>&1
#
# Config via env:
#   BACKUP_DIR              — default ./backups (first positional arg overrides)
#   BACKUP_RETENTION_DAYS   — default 7
# ============================================================================

set -euo pipefail

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="govai_backup_${TIMESTAMP}.sql.gz"
FULLPATH="${BACKUP_DIR}/${FILENAME}"

echo "==== [GovAI] Starting Database Backup ===="
echo "Target: $FULLPATH"
echo "Retention: $RETENTION_DAYS days"

mkdir -p "$BACKUP_DIR"

# ── Execute pg_dump inside the database container ──
# --no-owner --no-acl: portable dump (restoreable to any superuser)
docker compose exec -T database pg_dump -U postgres -d govai_platform \
    --no-owner --no-acl | gzip > "$FULLPATH"

# ── Validate the file exists and is non-trivially sized ──
if [ ! -f "$FULLPATH" ]; then
    echo "❌ ERROR: Backup file not found."
    exit 1
fi

# Accept both BSD stat (macOS) and GNU stat (Linux)
SIZE=$(stat -f%z "$FULLPATH" 2>/dev/null || stat -c%s "$FULLPATH")
if [ "${SIZE:-0}" -lt 1024 ]; then
    echo "❌ ERROR: Backup file too small (${SIZE} bytes) — likely failed."
    rm -f "$FULLPATH"
    exit 1
fi

HUMAN_SIZE=$(du -h "$FULLPATH" | cut -f1)
echo "✅ Backup completed: $HUMAN_SIZE"

# ── Rotate: delete backups older than RETENTION_DAYS ──
DELETED_COUNT=$(find "$BACKUP_DIR" -name "govai_backup_*.sql.gz" -mtime +$RETENTION_DAYS -print -delete 2>/dev/null | wc -l | tr -d ' ')
echo "→ Retention: rotated $DELETED_COUNT older backup(s)"

# ── Record a metric in audit_logs so operators can see backup history ──
docker compose exec -T database psql -U postgres -d govai_platform -c "
    INSERT INTO audit_logs_partitioned (action, metadata, created_at)
    VALUES ('BACKUP_COMPLETED',
            jsonb_build_object(
                'size_bytes', $SIZE,
                'file', '$FILENAME',
                'retention_days', $RETENTION_DAYS
            ),
            NOW())
" >/dev/null 2>&1 || echo "⚠️  Could not write backup audit log (non-fatal)"

echo "==== [GovAI] Backup Cycle Ended ===="
