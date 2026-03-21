#!/bin/bash
set -euo pipefail

CONTAINER_NAME=govai_migration_test

cleanup() {
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  echo "Banco de teste removido."
}
trap cleanup EXIT

echo "=== Teste de migrations em banco limpo ==="

# Remove container anterior se já existir
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Subir banco temporário isolado
docker run -d --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=govai_platform \
  -p 5433:5432 \
  pgvector/pgvector:pg15

# Aguardar o banco estar pronto
echo "Aguardando PostgreSQL inicializar..."
for i in $(seq 1 15); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres -q 2>/dev/null; then
    echo "Banco pronto (${i}s)."
    break
  fi
  sleep 1
done

# Criar role govai_app (necessária para migrations S12+)
docker exec "$CONTAINER_NAME" psql -U postgres -d govai_platform -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'govai_app') THEN
       CREATE ROLE govai_app WITH LOGIN PASSWORD 'govai_platform_app_password';
     END IF;
   END \$\$;" > /dev/null

# Aplicar init.sql
echo "Aplicando init.sql..."
docker exec -i "$CONTAINER_NAME" psql -U postgres -d govai_platform \
  -v ON_ERROR_STOP=1 < init.sql
echo "init.sql aplicado."

# Criar tabela de tracking _migrations (criada pelo migrate.sh em produção)
docker exec "$CONTAINER_NAME" psql -U postgres -d govai_platform -c \
  "CREATE TABLE IF NOT EXISTS _migrations (
     name       TEXT PRIMARY KEY,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );" > /dev/null

# Aplicar migrations numeradas em ordem
MIGRATIONS=$(ls [0-9][0-9][0-9]_*.sql 2>/dev/null | sort)
COUNT=0
for migration in $MIGRATIONS; do
  echo "  → $migration"
  docker exec -i "$CONTAINER_NAME" psql -U postgres \
    -d govai_platform -v ON_ERROR_STOP=1 < "$migration"
  COUNT=$((COUNT + 1))
done

echo ""
echo "=== RESULTADO: Todas as migrations aplicadas com sucesso ==="
echo "    Migrations aplicadas: $COUNT"
docker exec "$CONTAINER_NAME" psql -U postgres -d govai_platform \
  -c "SELECT count(*) as total_migrations FROM _migrations;" 2>/dev/null || true
