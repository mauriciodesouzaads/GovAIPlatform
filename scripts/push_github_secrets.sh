#!/bin/bash

# GovAI Platform - GitHub Secrets Sync Script
# Este script automatiza a injeção de variáveis de ambiente do .env para o GitHub Secrets.

ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Erro: Arquivo $ENV_FILE não encontrado na raiz do projeto."
    exit 1
fi

if ! command -v gh &> /dev/null; then
    echo "❌ Erro: GitHub CLI (gh) não está instalado. Instale-o com 'brew install gh'."
    exit 1
fi

echo "🚀 Iniciando sincronização de segredos com o GitHub..."

# Lê o arquivo .env linha por linha, ignora comentários e envia para o GitHub Secrets
while IFS= read -r line || [ -n "$line" ]; do
    # Ignora linhas vazias ou que começam com #
    [[ "$line" =~ ^#.*$ ]] && continue
    [[ -z "$line" ]] && continue

    # Extrai chave e valor (suporta valores com espaços se estiverem entre aspas no .env)
    KEY=$(echo "$line" | cut -d '=' -f 1)
    VALUE=$(echo "$line" | cut -d '=' -f 2-)

    # Remove aspas se existirem no valor
    VALUE="${VALUE%\"}"
    VALUE="${VALUE#\"}"

    if [ -n "$KEY" ]; then
        echo "📤 Injetando Secret: $KEY..."
        echo "$VALUE" | gh secret set "$KEY"
    fi
done < "$ENV_FILE"

echo "✅ Sincronização concluída com sucesso!"
