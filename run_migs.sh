#!/bin/bash
# run_migs.sh — Executa migrations via container da API.
# Uso: ./run_migs.sh
#
# Lê apenas DB_PASSWORD e DB_APP_PASSWORD do .env (não faz `source .env` completo
# para evitar expor todos os segredos no ambiente do shell).

set -e

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Arquivo .env não encontrado. Execute scripts/bootstrap.sh primeiro."
    exit 1
fi

# Extrai apenas as variáveis necessárias sem poluir o ambiente
DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d '=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$DB_PASSWORD" ]; then
    echo "❌ DB_PASSWORD não definida no .env"
    exit 1
fi

echo "▶ Executando migrations via container..."
docker compose run --rm \
    -e DATABASE_URL="postgresql://postgres:${DB_PASSWORD}@database:5432/govai_platform" \
    api bash ./scripts/migrate.sh

echo "✅ Migrations concluídas."
