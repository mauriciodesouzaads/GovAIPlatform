#!/usr/bin/env bash
# =============================================================================
# GovAI Platform — Revogar API Key exposta acidentalmente no repositório Git
# =============================================================================
# Contexto:
#   O prefixo sk-govai-1e3a foi versionado em stress_test.js.
#   Mesmo sem o sufixo completo, o prefixo é indexado na coluna `prefix`
#   de api_keys e reduz o espaço de brute-force.
#   Esta chave deve ser revogada ANTES de qualquer deploy em produção.
#
# Uso:
#   bash scripts/revoke-exposed-key.sh
#
# Requer: docker compose com o serviço `database` em execução
# =============================================================================

set -euo pipefail

EXPOSED_PREFIX="sk-govai-1e3a"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║   GovAI Platform — Revogar Chave Exposta no Git          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "⚠️  Prefixo exposto: ${EXPOSED_PREFIX}..."
echo ""

# Verificar se docker compose está acessível
if ! docker compose ps > /dev/null 2>&1; then
    echo "❌ Docker Compose não encontrado ou não está em execução."
    echo "   Inicie com: docker compose up -d database"
    exit 1
fi

# Verificar se o container do banco responde
if ! docker compose exec -T database psql -U postgres -d govai_platform \
      -c "SELECT 1" > /dev/null 2>&1; then
    echo "❌ Container 'database' não está acessível."
    echo "   Inicie com: docker compose up -d database"
    exit 1
fi

echo "▶ Revogando chave com prefixo '${EXPOSED_PREFIX}%'..."
echo ""

# Revogar a chave exposta
REVOKE_RESULT=$(docker compose exec -T database psql \
    -U postgres \
    -d govai_platform \
    -c "UPDATE api_keys
        SET    is_active     = false,
               revoke_reason = 'exposed_in_git',
               revoked_at    = NOW()
        WHERE  prefix LIKE '${EXPOSED_PREFIX}%'
          AND  is_active = true
        RETURNING id, prefix, is_active, revoke_reason;" 2>&1)

echo "$REVOKE_RESULT"
echo ""

# Confirmar o estado atual
echo "▶ Estado atual das chaves com prefixo '${EXPOSED_PREFIX}%':"
docker compose exec -T database psql \
    -U postgres \
    -d govai_platform \
    -c "SELECT id, prefix, is_active, revoke_reason, revoked_at
        FROM api_keys
        WHERE prefix LIKE '${EXPOSED_PREFIX}%';" 2>&1

echo ""
echo "════════════════════════════════════════════════════════════"

# Verificar se ainda há alguma chave ativa com esse prefixo
ACTIVE_COUNT=$(docker compose exec -T database psql \
    -U postgres \
    -d govai_platform \
    -tAq \
    -c "SELECT COUNT(*) FROM api_keys WHERE prefix LIKE '${EXPOSED_PREFIX}%' AND is_active = true;" 2>/dev/null || echo "0")

if [ "$ACTIVE_COUNT" = "0" ]; then
    echo "✅ Nenhuma chave ativa com prefixo '${EXPOSED_PREFIX}%' — revogação concluída."
else
    echo "❌ ALERTA: Ainda existem ${ACTIVE_COUNT} chave(s) ativa(s) com prefixo '${EXPOSED_PREFIX}%'!"
    echo "   Investigue manualmente: docker compose exec database psql -U postgres -d govai_platform"
    exit 1
fi

echo ""
echo "🔒 Próximos passos obrigatórios:"
echo "   1. Gerar uma nova API key via POST /v1/admin/api-keys"
echo "   2. Atualizar os sistemas que usavam a chave revogada"
echo "   3. Considerar git-filter-repo para remover o commit do histórico"
echo "   4. Forçar re-autenticação de todas as sessões ativas (opcional)"
