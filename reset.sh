#!/bin/bash
# reset.sh — Master reset script for GovAI Platform
set -e

echo "🛑 Stopping and cleaning containers..."
docker compose down -v

echo "⚙️  Running setup..."
bash setup_phase.sh

echo "🚀 Building and starting containers..."
docker compose up -d --build

echo "⏳ Waiting for database and API (15s)..."
sleep 15

echo "🗄️  Running migrations..."
docker compose exec api bash scripts/migrate.sh

echo "🌱 Seeding demo data..."
docker compose exec api bash scripts/demo-seed.sh

echo "✅ Environment Reset Complete!"
echo "API Health: http://localhost:3000/health"
echo "Admin UI:   http://localhost:3001"
