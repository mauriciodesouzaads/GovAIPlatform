#!/bin/bash
set -e

echo "=== GovAI Platform: Setup do Ambiente Local ==="

# Gerar ORG_MASTER_KEY com entropia real
ORG_KEY=$(openssl rand -hex 16)

cat > .env << EOF
# GovAI Platform — Ambiente Local
GEMINI_API_KEY=mock-gemini-key-for-e2e
AI_MODEL=gemini/gemini-1.5-flash
LITELLM_KEY=local-dev-litellm-key

# Database
DB_PASSWORD=$(openssl rand -hex 16)
DB_APP_PASSWORD=$(openssl rand -hex 16)

# Security
SIGNING_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

# KMS
ORG_MASTER_KEY=${ORG_KEY}

# App
PORT=3000
LOG_LEVEL=info
APP_BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3001
ADMIN_UI_ORIGIN=http://localhost:3001

# Presidio NLP
PRESIDIO_URL=http://presidio:5001

# OIDC (dummy)
OIDC_ISSUER_URL=https://login.microsoftonline.com/common/v2.0
OIDC_CLIENT_ID=dummy-client-id
OIDC_CLIENT_SECRET=dummy-client-secret

# Langfuse (dummy)
LANGFUSE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-dummy
LANGFUSE_SECRET_KEY=sk-lf-dummy
EOF

# Garantir que .env não está trackado
git rm --cached .env 2>/dev/null || true

echo "✅ .env gerado com credenciais seguras"
echo "✅ Setup concluído. Pronto para o reset."
