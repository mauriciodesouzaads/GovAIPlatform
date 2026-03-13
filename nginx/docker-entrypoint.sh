#!/bin/sh
# ============================================================================
# GovAI Platform — Nginx Custom Entrypoint
# ============================================================================
# Executa envsubst com APENAS as variáveis de domínio específicas.
# Variáveis nativas do nginx ($host, $request_uri, $binary_remote_addr, etc.)
# permanecem intactas porque não estão na lista de substituição.
#
# Envsubst com lista explícita: envsubst '${VAR1} ${VAR2}' substitui apenas
# VAR1 e VAR2 — qualquer outro $xxx no arquivo é deixado como está.
# ============================================================================
set -eu

: "${API_DOMAIN:=api.govai-platform.com}"
: "${ADMIN_DOMAIN:=admin.govai-platform.com}"
: "${GRAFANA_DOMAIN:=grafana.govai-platform.com}"

TEMPLATE=/etc/nginx/nginx.conf.template
OUTPUT=/etc/nginx/nginx.conf

if [ ! -f "$TEMPLATE" ]; then
    echo "[nginx-entrypoint] ERRO: template não encontrado em $TEMPLATE" >&2
    exit 1
fi

echo "[nginx-entrypoint] Processando template com envsubst..."
echo "[nginx-entrypoint]   API_DOMAIN     = ${API_DOMAIN}"
echo "[nginx-entrypoint]   ADMIN_DOMAIN   = ${ADMIN_DOMAIN}"
echo "[nginx-entrypoint]   GRAFANA_DOMAIN = ${GRAFANA_DOMAIN}"

# Substitui apenas as variáveis de domínio — nginx vars ($host, etc.) ficam intactas
envsubst '${API_DOMAIN} ${ADMIN_DOMAIN} ${GRAFANA_DOMAIN}' \
    < "$TEMPLATE" \
    > "$OUTPUT"

echo "[nginx-entrypoint] Validando configuração..."
nginx -t -c "$OUTPUT"

echo "[nginx-entrypoint] Iniciando nginx..."
exec nginx -g 'daemon off;' -c "$OUTPUT"
