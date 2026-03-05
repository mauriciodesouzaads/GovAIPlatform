#!/bin/bash
set -e
echo "GEMINI_API_KEY=mock-gemini-key-for-e2e" > .env
echo "AI_MODEL=gemini/gemini-1.5-flash" >> .env
echo "LITELLM_KEY=sk-govai-local" >> .env
echo "DB_PASSWORD=$(openssl rand -hex 16)" >> .env
echo "DB_APP_PASSWORD=$(openssl rand -hex 16)" >> .env
echo "SIGNING_SECRET=$(openssl rand -hex 32)" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "PORT=3000" >> .env
echo "LOG_LEVEL=info" >> .env
echo "APP_BASE_URL=http://localhost:3000" >> .env
echo "FRONTEND_URL=http://localhost:3001" >> .env
echo "ADMIN_UI_ORIGIN=http://localhost:3001" >> .env
echo "PRESIDIO_URL=http://presidio:5001" >> .env
echo "OIDC_ISSUER_URL=https://login.microsoftonline.com/common/v2.0" >> .env
echo "OIDC_CLIENT_ID=dummy-client-id" >> .env
echo "OIDC_CLIENT_SECRET=dummy-client-secret" >> .env
echo "ORG_MASTER_KEY=12345678901234567890123456789012" >> .env
echo "LANGFUSE_URL=https://cloud.langfuse.com" >> .env
echo "LANGFUSE_PUBLIC_KEY=pk-lf-dummy" >> .env
echo "LANGFUSE_SECRET_KEY=sk-lf-dummy" >> .env

git rm --cached .env || true

docker compose build --no-cache
docker compose up -d

