#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Startup Automático (Mac)
# Execute na raiz do projeto:
#   chmod +x start.sh && ./start.sh
# ============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok() { echo -e "  ${GREEN}✅ $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ  $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠  $1${NC}"; }

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════╗"
echo "║       GovAI Platform — Startup Automático        ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Verificar que estamos na raiz do projeto ──────────────────────────
if [ ! -f "package.json" ] || [ ! -d "admin-ui" ]; then
    fail "Não está na raiz do projeto GovAI."
    echo "  Execute: cd ~/Desktop/TRABALHO/GovAI\ -\ Enterprise\ AI\ GRC\ /GitHub\ /GovAI\ GRC\ Platform"
    exit 1
fi
ok "Diretório correto: $(basename $(pwd))"

# ── 2. Matar processos stale de Next.js ──────────────────────────────────
echo ""
info "Matando processos Next.js antigos..."
pkill -f "next dev" 2>/dev/null && warn "Processos next dev encerrados" || ok "Nenhum processo stale"
pkill -f "next-server" 2>/dev/null || true
sleep 1

# ── 3. Liberar portas 3000, 3001, 4000 ──────────────────────────────────
for port in 3000 3001 4000; do
    pid=$(lsof -ti :$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
        kill -9 $pid 2>/dev/null || true
        warn "Porta $port liberada (PID $pid encerrado)"
    else
        ok "Porta $port livre"
    fi
done
sleep 1

# ── 4. Criar .env se não existir ─────────────────────────────────────────
echo ""
if [ ! -f .env ]; then
    info "Criando .env a partir de .env.example..."
    cp .env.example .env
    ok ".env criado"
else
    ok ".env já existe"
fi

# ── 5. Verificar GROQ_API_KEY ────────────────────────────────────────────
source .env 2>/dev/null || true
if [ -z "${GROQ_API_KEY:-}" ] || [[ "${GROQ_API_KEY}" == *"your-groq"* ]]; then
    warn "GROQ_API_KEY não configurada. Configurando agora..."
    # Usar sed para substituir a linha no .env
    fail "Configure GROQ_API_KEY no arquivo .env antes de continuar."
    echo "  Edite .env e defina: GROQ_API_KEY=<sua-chave-groq>"
    exit 1
    ok "GROQ_API_KEY configurada"
else
    ok "GROQ_API_KEY já configurada"
fi

# ── 6. Docker: parar tudo e reconstruir ──────────────────────────────────
echo ""
info "Parando containers Docker existentes..."
docker compose down 2>/dev/null || true
ok "Containers parados"

echo ""
info "Reconstruindo imagens (--no-cache para admin-ui)..."
docker compose build admin-ui --no-cache 2>&1 | tail -3
docker compose build api 2>&1 | tail -3
ok "Imagens reconstruídas"

# ── 7. Subir tudo ────────────────────────────────────────────────────────
echo ""
info "Subindo todos os serviços..."
docker compose up -d
ok "Docker compose up"

# ── 8. Aguardar health checks ────────────────────────────────────────────
echo ""
info "Aguardando serviços ficarem healthy (pode levar 2-3 min)..."

wait_for_service() {
    local name=$1
    local url=$2
    local max_wait=$3
    local elapsed=0
    while [ $elapsed -lt $max_wait ]; do
        if curl -sf "$url" >/dev/null 2>&1; then
            ok "$name respondendo"
            return 0
        fi
        sleep 5
        elapsed=$((elapsed + 5))
        echo -ne "  ⏳ $name: aguardando... (${elapsed}s/${max_wait}s)\r"
    done
    fail "$name não respondeu em ${max_wait}s"
    return 1
}

wait_for_service "Database" "localhost:5432" 30 2>/dev/null || true
wait_for_service "Redis" "localhost:6379" 20 2>/dev/null || true
wait_for_service "LiteLLM" "http://localhost:4000/health" 90
wait_for_service "Backend API" "http://localhost:3000/health" 120
wait_for_service "Admin UI" "http://localhost:3001" 90

# ── 9. Testar login ─────────────────────────────────────────────────────
echo ""
info "Testando login..."
LOGIN=$(curl -sf -X POST http://localhost:3000/v1/admin/login \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' 2>/dev/null || echo "FAIL")

if echo "$LOGIN" | grep -q "token"; then
    ok "Login funcionando"
    echo -e "  ${GREEN}Email: admin@orga.com${NC}"
    echo -e "  ${GREEN}Senha: GovAI2026@Admin${NC}"
else
    warn "Login falhou — seed pode não ter rodado ainda. Aguarde 30s e tente novamente."
fi

# ── 10. Status final ─────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║           APLICAÇÃO ONLINE                       ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║                                                  ║"
echo "║  Admin UI:  http://localhost:3001                ║"
echo "║  Backend:   http://localhost:3000                ║"
echo "║  LiteLLM:   http://localhost:4000                ║"
echo "║                                                  ║"
echo "║  Login:     admin@orga.com                       ║"
echo "║  Senha:     GovAI2026@Admin                      ║"
echo "║                                                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Abra http://localhost:3001 no navegador."
echo ""
echo "  Para parar tudo: docker compose down"
echo "  Para ver logs:   docker compose logs -f api"
echo "  Para ver UI:     docker compose logs -f admin-ui"
