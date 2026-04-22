#!/usr/bin/env bash
# ============================================================================
# dev-up-full.sh — FASE 13.5a1
# ----------------------------------------------------------------------------
# Sobe o stack completo de desenvolvimento, incluindo o runtime oficial
# do Claude Code sob o profile `official`. Complementa
# `docker compose --profile dev up -d` para operadores que querem ver
# ambos os runtimes disponíveis no selector da UI.
#
# Sem ANTHROPIC_API_KEY configurada, o Claude Code Official aparece como
# "Indisponível" — isso é correto (o container sobe mas não consegue
# executar runs sem a chave). O script avisa mas não bloqueia.
# ============================================================================

set -e

cd "$(dirname "$0")/.."

# Sanity check: ANTHROPIC_API_KEY no .env
if [ ! -f .env ]; then
    echo "⚠️  .env não existe. Copie de .env.example e preencha suas chaves."
    echo "    cp .env.example .env"
    exit 1
fi

ANTHROPIC_KEY_VALUE=$(grep '^ANTHROPIC_API_KEY=' .env 2>/dev/null | cut -d= -f2-)
if [ -z "$ANTHROPIC_KEY_VALUE" ] || [ "$ANTHROPIC_KEY_VALUE" = "" ]; then
    echo "⚠️  ANTHROPIC_API_KEY vazia no .env."
    echo "    O container claude-code-runner vai subir mas aparecerá como 'Indisponível' na UI."
    echo "    Para habilitar: adicione sua chave (sk-ant-...) em .env e rode novamente."
    echo ""
fi

echo "🚀 Subindo stack completo (profile dev + official)…"
docker compose --profile dev --profile official up -d

echo ""
echo "⏳ Aguardando containers ficarem healthy…"
for i in $(seq 1 30); do
    UNHEALTHY=$(docker compose --profile dev --profile official ps --format '{{.Name}} {{.Status}}' 2>/dev/null \
        | grep -cvE 'healthy|\(starting\)|NAME' || true)
    STARTING=$(docker compose --profile dev --profile official ps --format '{{.Status}}' 2>/dev/null \
        | grep -c 'starting' || true)
    if [ "$UNHEALTHY" = "0" ] && [ "$STARTING" = "0" ]; then
        break
    fi
    sleep 3
done

echo ""
docker compose --profile dev --profile official ps

echo ""
echo "✅ Stack completo pronto."
echo "   - admin-ui:            http://localhost:3001"
echo "   - api:                 http://localhost:3000"
echo "   - swagger UI:          http://localhost:3000/v1/docs"
