#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Startup Script
# ============================================================================
# Usage:
#   ./scripts/start.sh [dev|prod|stop|logs|status]
#
# Modes:
#   dev   — builds and starts all services with development overrides
#           (docker-compose.override.yml loaded automatically)
#   prod  — builds and starts all services in production mode
#           (override.yml skipped via explicit -f flag)
#   stop  — stops and removes containers (keeps volumes)
#   logs  — follow logs for all running services
#   status — show status of running services
# ============================================================================

set -euo pipefail

MODE="${1:-dev}"

COMPOSE_BASE="-f docker-compose.yml"
COMPOSE_PROD="$COMPOSE_BASE"           # no override in prod
COMPOSE_DEV=""                          # dev picks up override.yml automatically

echo "╔══════════════════════════════════════════════════╗"
echo "║         GovAI Platform — Start Script            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

case "$MODE" in
  dev)
    echo "▶ Mode: DEVELOPMENT (with override.yml)"
    echo ""
    COMPOSE_PROFILES=dev docker compose $COMPOSE_DEV up --build "$@"
    ;;

  prod)
    echo "▶ Mode: PRODUCTION (no override.yml)"
    echo ""
    COMPOSE_PROFILES=prod docker compose $COMPOSE_PROD up --build -d "${@:2}"
    echo ""
    echo "✅ GovAI Platform started in production mode (detached)."
    echo "   API:      http://localhost:3000"
    echo "   Admin UI: http://localhost:3001"
    echo ""
    echo "   Logs:   ./scripts/start.sh logs"
    echo "   Stop:   ./scripts/start.sh stop"
    ;;

  stop)
    echo "▶ Stopping GovAI Platform..."
    echo ""
    COMPOSE_PROFILES=dev docker compose down
    echo "✅ All containers stopped. Volumes preserved."
    ;;

  logs)
    echo "▶ Following logs (Ctrl+C to exit)..."
    COMPOSE_PROFILES=dev docker compose logs -f "${@:2}"
    ;;

  status)
    COMPOSE_PROFILES=dev docker compose ps
    ;;

  *)
    echo "Usage: $0 [dev|prod|stop|logs|status]"
    echo ""
    echo "  dev     Build and start all services (development)"
    echo "  prod    Build and start all services (production, detached)"
    echo "  stop    Stop all containers (volumes preserved)"
    echo "  logs    Follow container logs"
    echo "  status  Show container status"
    exit 1
    ;;
esac
