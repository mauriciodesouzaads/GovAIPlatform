#!/bin/bash
set -e

# GovAI Platform - Automated Backup Script
# Usage: ./scripts/backup-db.sh [backup_dir]

BACKUP_DIR=${1:-"./backups"}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="govai_backup_${TIMESTAMP}.sql.gz"

echo "==== [GovAI] Starting Database Backup ===="
echo "Target: ${BACKUP_DIR}/${FILENAME}"

mkdir -p "$BACKUP_DIR"

# Execute pg_dump inside the docker container
# Assuming DB_PASSWORD is set or we use the container's environment
docker compose exec -T database pg_dump -U postgres govai_platform | gzip > "${BACKUP_DIR}/${FILENAME}"

if [ -f "${BACKUP_DIR}/${FILENAME}" ]; then
    echo "✅ Backup completed successfully."
    echo "Size: $(du -sh ${BACKUP_DIR}/${FILENAME} | cut -f1)"
else
    echo "❌ ERROR: Backup file not found. Check permissions or database status."
    exit 1
fi

# Rotate backups: Keep only the last 7 days
find "$BACKUP_DIR" -name "govai_backup_*.sql.gz" -mtime +7 -delete
echo "==== [GovAI] Backup Cycle Ended ===="
