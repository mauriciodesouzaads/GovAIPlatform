#!/usr/bin/env bash
# =============================================================================
# GovAI Platform — VPS Deploy Script (Ubuntu 22.04 LTS)
# =============================================================================
# Uso:
#   chmod +x deploy/vps.sh
#   sudo ./deploy/vps.sh
#
# O script é idempotente: pode ser re-executado para atualizar o stack.
# Em CI/CD (GitHub Actions deploy job), roda via SSH no servidor alvo.
#
# Pré-requisitos no servidor:
#   - Ubuntu 22.04 LTS
#   - Acesso root ou usuário com sudo
#   - .env.prod configurado em /opt/govai-platform/.env.prod
#   - Certificados SSL em /etc/ssl/govai/{cert.pem,key.pem}
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/your-org/govai-platform.git}"
APP_DIR="${APP_DIR:-/opt/govai-platform}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.prod"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Verificar dependências
# ---------------------------------------------------------------------------
log "Verificando dependências..."

check_dep() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

install_docker() {
  log "Instalando Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
  log "Docker instalado: $(docker --version)"
}

if ! check_dep docker; then
  install_docker
else
  log "Docker: $(docker --version)"
fi

if ! check_dep git; then
  log "Instalando git..."
  apt-get update -qq && apt-get install -y -qq git
fi

# ---------------------------------------------------------------------------
# 2. Clonar ou atualizar repositório
# ---------------------------------------------------------------------------
log "Atualizando código..."

if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
  log "Repositório atualizado para branch $BRANCH ($(git rev-parse --short HEAD))"
else
  log "Clonando repositório em $APP_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
  log "Clone concluído ($(git rev-parse --short HEAD))"
fi

# ---------------------------------------------------------------------------
# 3. Verificar .env.prod
# ---------------------------------------------------------------------------
if [ ! -f "$APP_DIR/$ENV_FILE" ]; then
  fail "$APP_DIR/$ENV_FILE não encontrado.
  Copie .env.prod.example, preencha todos os valores e coloque em $APP_DIR/$ENV_FILE"
fi

# Verificar variáveis obrigatórias
REQUIRED_VARS=(
  DB_PASSWORD DB_APP_PASSWORD REDIS_PASSWORD
  SIGNING_SECRET JWT_SECRET METRICS_API_KEY ORG_MASTER_KEY
  GEMINI_API_KEY LITELLM_KEY
  APP_BASE_URL FRONTEND_URL ADMIN_UI_ORIGIN NEXT_PUBLIC_API_URL
)

log "Verificando variáveis obrigatórias em $ENV_FILE..."
missing=0
for var in "${REQUIRED_VARS[@]}"; do
  # shellcheck disable=SC1091
  val=$(grep -E "^${var}=" "$APP_DIR/$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)
  if [ -z "$val" ] || [[ "$val" == change-me* ]]; then
    warn "Variável não configurada ou com valor placeholder: $var"
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  fail "$missing variável(is) não configurada(s) em $ENV_FILE. Configure antes de continuar."
fi
log "Todas as variáveis obrigatórias estão definidas."

# ---------------------------------------------------------------------------
# 4. Criar diretórios de runtime
# ---------------------------------------------------------------------------
log "Criando diretórios de runtime..."
mkdir -p /var/log/govai/nginx
chown -R 101:101 /var/log/govai/nginx 2>/dev/null || true  # nginx UID

# ---------------------------------------------------------------------------
# 5. Pull de imagens e build
# ---------------------------------------------------------------------------
log "Fazendo pull das imagens e build dos containers..."
cd "$APP_DIR"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull --ignore-pull-failures 2>/dev/null || true
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --no-cache

# ---------------------------------------------------------------------------
# 6. Aplicar migrations
# ---------------------------------------------------------------------------
log "Aplicando migrations do banco de dados..."

# Sobe apenas o banco temporariamente se necessário
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d database
log "Aguardando banco ficar saudável..."
timeout 60 bash -c "
  until docker compose -f $COMPOSE_FILE --env-file $ENV_FILE \
    exec -T database pg_isready -U postgres -d govai_platform; do
    sleep 2
  done
"

# Exporta DATABASE_URL para o script de migration
DB_APP_PASSWORD=$(grep -E '^DB_APP_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)
export DATABASE_URL="postgresql://postgres:$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)@localhost:5432/govai_platform"

# Expõe a porta temporariamente para rodar migrate.sh no host
# Alternativa: rodar dentro do container database
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
  exec -T database bash -c "
    cd /var/lib/postgresql
    ls /docker-entrypoint-initdb.d/
  " 2>/dev/null || true

# Roda migrate.sh via container temporário com acesso à rede interna
log "Executando scripts de migration..."
docker run --rm \
  --network govai_prod_net \
  -v "$APP_DIR/scripts:/scripts:ro" \
  -e DATABASE_URL="postgresql://postgres:$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)@database:5432/govai_platform" \
  postgres:15-alpine \
  bash /scripts/migrate.sh || warn "migrate.sh falhou — verifique se as migrations já foram aplicadas."

# ---------------------------------------------------------------------------
# 7. Subir o stack completo
# ---------------------------------------------------------------------------
log "Subindo stack de produção..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

# ---------------------------------------------------------------------------
# 8. Health check
# ---------------------------------------------------------------------------
log "Verificando saúde dos serviços..."
sleep 10

UNHEALTHY=0
for service in database redis litellm presidio api admin-ui; do
  status=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    ps --format json "$service" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health','unknown') if isinstance(d,dict) else d[0].get('Health','unknown'))" \
    2>/dev/null || echo "unknown")
  if [ "$status" = "healthy" ]; then
    log "  $service: healthy"
  else
    warn "  $service: $status (pode ainda estar iniciando)"
    UNHEALTHY=$((UNHEALTHY + 1))
  fi
done

if [ "$UNHEALTHY" -gt 0 ]; then
  warn "$UNHEALTHY serviço(s) ainda não saudável(is). Monitore com:"
  warn "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps"
  warn "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f --tail=50"
else
  log "Todos os serviços estão saudáveis!"
fi

# ---------------------------------------------------------------------------
# 9. Resumo
# ---------------------------------------------------------------------------
echo ""
log "============================================================"
log "Deploy concluído — GovAI Platform"
log "Commit: $(git -C "$APP_DIR" rev-parse --short HEAD)"
log "Branch: $BRANCH"
log "Hora:   $(date '+%Y-%m-%d %H:%M:%S %Z')"
log "============================================================"
log "URLs (configure DNS para apontar para este servidor):"
APP_BASE_URL=$(grep -E '^APP_BASE_URL=' "$APP_DIR/$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)
FRONTEND_URL=$(grep -E '^FRONTEND_URL=' "$APP_DIR/$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)
log "  API:      $APP_BASE_URL"
log "  Admin UI: $FRONTEND_URL"
log ""
log "Comandos úteis:"
log "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f api"
log "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE ps"
log "  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE restart api"
