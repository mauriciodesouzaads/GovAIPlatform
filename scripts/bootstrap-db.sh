#!/bin/bash
# scripts/bootstrap-db.sh
# Bootstrap database roles and permissions using environment variables.
# Usage: DB_PASSWORD=xxx DB_APP_PASSWORD=yyy bash scripts/bootstrap-db.sh

set -e

DB_HOST=${DB_HOST:-"localhost"}
DB_PORT=${DB_PORT:-"5432"}
DB_NAME=${DB_NAME:-"govai_platform"}
POSTGRES_USER=${POSTGRES_USER:-"postgres"}

if [ -z "$DB_PASSWORD" ] || [ -z "$DB_APP_PASSWORD" ]; then
    echo "Error: DB_PASSWORD and DB_APP_PASSWORD must be set."
    exit 1
fi

echo "--- Bootstrapping roles for $DB_NAME on $DB_HOST:$DB_PORT..."

export PGPASSWORD="$DB_PASSWORD"

# 1. Cria/atualiza a role da aplicação com a senha provida
psql -h "$DB_HOST" -p "$DB_PORT" -U "$POSTGRES_USER" -d "$DB_NAME" <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'govai_app') THEN
        CREATE ROLE govai_app WITH LOGIN PASSWORD '${DB_APP_PASSWORD}';
    ELSE
        ALTER ROLE govai_app WITH PASSWORD '${DB_APP_PASSWORD}';
    END IF;
END \$\$;

-- Privilégios mínimos necessários: conexão ao banco e uso do schema public.
-- Acesso a tabelas é concedido após as migrations criarem o schema.
GRANT CONNECT ON DATABASE ${DB_NAME} TO govai_app;
GRANT USAGE ON SCHEMA public TO govai_app;

-- DML apenas — govai_app não precisa de DDL (CREATE/DROP/ALTER).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO govai_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO govai_app;

-- Garante privilégios nas tabelas criadas por migrations futuras
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO govai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO govai_app;
EOF

echo "✅ Database roles provisioned successfully."
