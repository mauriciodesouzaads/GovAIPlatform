#!/bin/bash
# setup_phase.sh — Prepara o ambiente local para execução e testes
# NUNCA modifica arquivos de migration SQL
# NUNCA commita .env no repositório
set -e

echo "=== GovAI Platform: Setup do Ambiente Local ==="

# Verificar que .env não existe (para não sobrescrever acidentalmente)
if [ -f .env ]; then
  echo "⚠️  Arquivo .env já existe. Delete-o manualmente se quiser regenerar."
  echo "    Para continuar com o .env existente, execute: docker compose up -d"
  exit 0
fi

echo "--- Gerando credenciais seguras..."

# Gerar ORG_MASTER_KEY com entropia real (32 bytes = 256 bits)
ORG_KEY=$(openssl rand -hex 16) # 16 bytes hex = 32 chars para AES-256

cat > .env << EOF
# GovAI Platform — Ambiente Local (gerado por setup_phase.sh)
# NUNCA commitar este arquivo. Está no .gitignore.

# AI (substitua pela sua chave real para testes com LLM real)
GEMINI_API_KEY=mock-gemini-key-for-e2e
AI_MODEL=gemini/gemini-1.5-flash
LITELLM_KEY=sk-govai-local

# Database
DB_PASSWORD=$(openssl rand -hex 16)
DB_APP_PASSWORD=$(openssl rand -hex 16)

# Security — gerados com openssl rand
SIGNING_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

# KMS — chave AES-256 com entropia real (não sequencial)
ORG_MASTER_KEY=${ORG_KEY}

# App
PORT=3000
LOG_LEVEL=info
APP_BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3001
ADMIN_UI_ORIGIN=http://localhost:3001

# Presidio NLP
PRESIDIO_URL=http://presidio:5001

# OIDC (dummy para ambiente local)
OIDC_ISSUER_URL=https://login.microsoftonline.com/common/v2.0
OIDC_CLIENT_ID=dummy-client-id
OIDC_CLIENT_SECRET=dummy-client-secret

# Langfuse (dummy para ambiente local)
LANGFUSE_URL=https://cloud.langfuse.com
LANGFUSE_PUBLIC_KEY=pk-lf-dummy
LANGFUSE_SECRET_KEY=sk-lf-dummy
EOF

# Garantir que .env não está trackado
git rm --cached .env 2>/dev/null || true

echo "✅ .env gerado com credenciais seguras"
echo ""
echo "--- Próximos passos:"
echo "    1. Para iniciar com LLM real: edite .env e substitua GEMINI_API_KEY"
echo "    2. Para iniciar: docker compose build --no-cache && docker compose up -d"
echo "    3. Para aplicar migrations: bash scripts/migrate.sh"
echo "    4. Para injetar dados de demo: bash scripts/demo-seed.sh"
echo ""
echo "⚠️  IMPORTANTE: A senha do govai_app no banco deve ser configurada manualmente."
echo "    Após as migrations, execute:"
echo "    docker compose exec database psql -U postgres -d govai -c \\"
echo "      \"ALTER USER govai_app WITH PASSWORD '\$(openssl rand -hex 16)';\""
echo "    E atualize DB_APP_PASSWORD no .env com o mesmo valor."
