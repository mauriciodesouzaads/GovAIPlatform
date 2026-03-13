#!/bin/sh
# ============================================================================
# GovAI Platform — AlertManager Custom Entrypoint
# ============================================================================
# Processa o template alertmanager.yml.template com envsubst (apenas as vars
# específicas de configuração SMTP/Slack) antes de iniciar o AlertManager.
# ============================================================================
set -eu

TEMPLATE=/etc/alertmanager/alertmanager.yml.template
OUTPUT=/etc/alertmanager/alertmanager.yml

# Defaults para evitar falha se variável não definida (entrypoint apenas valida)
: "${ALERTMANAGER_SMTP_FROM:=alerts@govai-platform.com}"
: "${ALERTMANAGER_SMTP_HOST:=localhost:587}"
: "${ALERTMANAGER_SMTP_USER:=}"
: "${ALERTMANAGER_SMTP_PASSWORD:=}"
: "${ALERTMANAGER_EMAIL_TO_CRITICAL:=sre@govai-platform.com}"
: "${ALERTMANAGER_EMAIL_TO_WARN:=sre@govai-platform.com}"
: "${ALERTMANAGER_SLACK_URL:=http://localhost/no-slack-configured}"

if [ ! -f "$TEMPLATE" ]; then
    echo "[alertmanager-entrypoint] ERRO: template não encontrado em $TEMPLATE" >&2
    exit 1
fi

echo "[alertmanager-entrypoint] Processando template com envsubst..."
envsubst '${ALERTMANAGER_SMTP_FROM} ${ALERTMANAGER_SMTP_HOST} ${ALERTMANAGER_SMTP_USER} ${ALERTMANAGER_SMTP_PASSWORD} ${ALERTMANAGER_EMAIL_TO_CRITICAL} ${ALERTMANAGER_EMAIL_TO_WARN} ${ALERTMANAGER_SLACK_URL}' \
    < "$TEMPLATE" \
    > "$OUTPUT"

echo "[alertmanager-entrypoint] Validando configuração..."
amtool check-config "$OUTPUT"

echo "[alertmanager-entrypoint] Iniciando AlertManager..."
exec /bin/alertmanager \
    --config.file="$OUTPUT" \
    --storage.path=/alertmanager \
    --web.listen-address=:9093 \
    --cluster.listen-address=""
