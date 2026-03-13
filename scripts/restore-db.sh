#!/bin/bash
set -e

# GovAI Platform - Database Restore Script
# WARNING: This will overwrite the existing database!
# Usage: ./scripts/restore-db.sh <backup_file.sql.gz>

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <backup_file.sql.gz>"
    exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ ERROR: File $BACKUP_FILE not found."
    exit 1
fi

echo "⚠️  WARNING: This will DESTROY current data in the 'govai_platform' database."
read -p "Are you sure? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Abortado."
    exit 1
fi

echo "==== [GovAI] Starting Database Restore ===="
echo "Source: $BACKUP_FILE"

# Drop and Recreate DB to ensure clean state
docker compose exec -T database psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'govai_platform' AND pid <> pg_backend_pid();" || true
docker compose exec -T database psql -U postgres -c "DROP DATABASE IF EXISTS govai_platform;"
docker compose exec -T database psql -U postgres -c "CREATE DATABASE govai_platform;"

# Restore from compressed dump
gunzip -c "$BACKUP_FILE" | docker compose exec -T database psql -U postgres -d govai_platform

echo "✅ Restore completed successfully."
echo "==== [GovAI] System Recovered ===="
