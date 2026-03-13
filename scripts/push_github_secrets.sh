#!/bin/bash
# GovAI Platform — GitHub Secrets Sync Script
# Sincroniza variáveis de .env para GitHub Secrets.
# Apenas variáveis listadas em SECRETS_ALLOWLIST são enviadas — nunca variáveis
# de configuração não-sensível como PRESIDIO_URL, AI_MODEL, etc.

set -e

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Erro: Arquivo $ENV_FILE não encontrado na raiz do projeto."
    exit 1
fi

if ! command -v gh &> /dev/null; then
    echo "❌ Erro: GitHub CLI (gh) não está instalado. Instale-o com 'brew install gh'."
    exit 1
fi

# Allowlist de variáveis que devem ir para GitHub Secrets.
# Não adicione variáveis de configuração não-sensível aqui.
SECRETS_ALLOWLIST=(
    "SIGNING_SECRET"
    "JWT_SECRET"
    "DB_PASSWORD"
    "DB_APP_PASSWORD"
    "REDIS_PASSWORD"
    "ORG_MASTER_KEY"
    "GEMINI_API_KEY"
    "LITELLM_KEY"
    "OIDC_CLIENT_SECRET"
    "LANGFUSE_SECRET_KEY"
    "LANGFUSE_PUBLIC_KEY"
    "SENDGRID_API_KEY"
    "SLACK_WEBHOOK_URL"
)

echo "🚀 Iniciando sincronização de segredos com o GitHub..."

while IFS= read -r line || [ -n "$line" ]; do
    # Ignora linhas vazias ou comentários
    [[ "$line" =~ ^[[:space:]]*#.*$ ]] && continue
    [[ -z "${line// }" ]] && continue

    # Parsing robusto: captura KEY e o restante como VALUE
    # IFS= preserva espaços; '=' separa apenas no primeiro delimitador
    if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
        KEY="${BASH_REMATCH[1]}"
        VALUE="${BASH_REMATCH[2]}"
    else
        continue
    fi

    # Remove aspas externas do valor (se existirem)
    VALUE="${VALUE%\"}"
    VALUE="${VALUE#\"}"
    VALUE="${VALUE%\'}"
    VALUE="${VALUE#\'}"

    # Verifica se está na allowlist
    IS_ALLOWED=0
    for ALLOWED_KEY in "${SECRETS_ALLOWLIST[@]}"; do
        if [ "$KEY" = "$ALLOWED_KEY" ]; then
            IS_ALLOWED=1
            break
        fi
    done

    if [ "$IS_ALLOWED" -eq 0 ]; then
        echo "⏭  SKIP (não está na allowlist): $KEY"
        continue
    fi

    if [ -n "$KEY" ] && [ -n "$VALUE" ]; then
        echo "📤 Injetando Secret: $KEY..."
        # printf evita que valores com newlines causem problemas no pipe
        printf '%s' "$VALUE" | gh secret set "$KEY"
    else
        echo "⚠️  SKIP (valor vazio): $KEY"
    fi
done < "$ENV_FILE"

echo "✅ Sincronização concluída com sucesso!"
