#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Local Developer Onboarding Script
# ============================================================================
# This script prepares the local environment for development by generating
# necessary secrets safely. It avoids accidental production leaks.
# ============================================================================

set -e

RED="\033[1;31m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RESET="\033[0m"

echo -e "${YELLOW}Starting Local Developer Bootstrap for GovAI Platform...${RESET}\n"

if [ -f ".env" ]; then
    echo -e "${YELLOW}Warning: .env file already exists. Skipping secret generation.${RESET}"
    echo -e "If you want to regenerate secrets, please delete or rename your .env file and run this script again."
else
    echo -e "${GREEN}1. Creating .env from .env.example...${RESET}"
    cp .env.example .env

    echo -e "${GREEN}2. Generating cryptographic keys and database passwords...${RESET}"
    SIGNING_SECRET=$(openssl rand -hex 32)
    JWT_SECRET=$(openssl rand -hex 32)
    ORG_MASTER_KEY=$(openssl rand -hex 32)
    METRICS_API_KEY=$(openssl rand -hex 32)
    POSTGRES_PWD=$(openssl rand -base64 24 | tr -d '\n\r+/=' | cut -c1-32)
    DB_APP_PWD=$(openssl rand -base64 24 | tr -d '\n\r+/=' | cut -c1-32)
    REDIS_PWD=$(openssl rand -base64 24 | tr -d '\n\r+/=' | cut -c1-32)

    # Cross-platform sed compatibility for replacing empty secrets with generated ones
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS sed
        sed -i '' "s/^SIGNING_SECRET=.*/SIGNING_SECRET=${SIGNING_SECRET}/" .env
        sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" .env
        sed -i '' "s/^ORG_MASTER_KEY=.*/ORG_MASTER_KEY=${ORG_MASTER_KEY}/" .env
        sed -i '' "s/^METRICS_API_KEY=.*/METRICS_API_KEY=${METRICS_API_KEY}/" .env
        sed -i '' "s/^DB_PASSWORD=.*/DB_PASSWORD=${POSTGRES_PWD}/" .env
        sed -i '' "s/^DB_APP_PASSWORD=.*/DB_APP_PASSWORD=${DB_APP_PWD}/" .env
        sed -i '' "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=${REDIS_PWD}/" .env
    else
        # GNU sed
        sed -i "s/^SIGNING_SECRET=.*/SIGNING_SECRET=${SIGNING_SECRET}/" .env
        sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" .env
        sed -i "s/^ORG_MASTER_KEY=.*/ORG_MASTER_KEY=${ORG_MASTER_KEY}/" .env
        sed -i "s/^METRICS_API_KEY=.*/METRICS_API_KEY=${METRICS_API_KEY}/" .env
        sed -i "s/^DB_PASSWORD=.*/DB_PASSWORD=${POSTGRES_PWD}/" .env
        sed -i "s/^DB_APP_PASSWORD=.*/DB_APP_PASSWORD=${DB_APP_PWD}/" .env
        sed -i "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=${REDIS_PWD}/" .env
    fi

    echo -e "${GREEN}✅ Local environment (.env) successfully bootstrapped!${RESET}"
    echo -e "\n${YELLOW}Next steps:${RESET}"
    echo "1. Provide real values in your .env for GEMINI_API_KEY, LITELLM_KEY, etc."
    echo "2. Run 'docker-compose up -d' to start the services."
    echo "3. Run 'npm run db:setup' or './scripts/demo-seed.sh' to prime the database."
    echo -e "\n${RED}[!] NEVER COMMIT your .env file!${RESET} It contains sensitive credentials.\n"
fi
