#!/bin/bash
set -e

# ============================================================================
# GovAI Platform — Database Initialization Script
# Executed automatically by PostgreSQL container on first startup
# ============================================================================

if [ -z "$DB_APP_PASSWORD" ]; then
  echo "Error: DB_APP_PASSWORD environment variable is not set."
  exit 1
fi

echo "Initializing Database Roles for GovAI Platform..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'govai_app') THEN
        CREATE ROLE govai_app WITH LOGIN PASSWORD '${DB_APP_PASSWORD}';
      ELSE
        ALTER ROLE govai_app WITH PASSWORD '${DB_APP_PASSWORD}';
      END IF;
    END
    \$\$;
    -- Schema-level privileges são aplicados após as migrations criarem as tabelas
EOSQL

echo "Roles initialized successfully."
