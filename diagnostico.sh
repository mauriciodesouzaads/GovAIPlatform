#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Diagnóstico e Startup Completo
# ============================================================================
# Execute este script na raiz do projeto:
#   chmod +x diagnostico.sh && ./diagnostico.sh
#
# Ele verifica tudo e diz exatamente o que está errado.
# ============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✅ $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠  $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ  $1${NC}"; }
header() { echo -e "\n${BLUE}═══════════════════════════════════════════════════${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"; }

ERRORS=0

# ── 1. PRE-REQUISITOS ──────────────────────────────────────────────────────
header "1. PRÉ-REQUISITOS"

if command -v docker &>/dev/null; then
    pass "Docker instalado: $(docker --version | head -1)"
else
    fail "Docker NÃO instalado"
    ERRORS=$((ERRORS+1))
fi

if command -v docker compose &>/dev/null || docker compose version &>/dev/null 2>&1; then
    pass "Docker Compose disponível"
else
    fail "Docker Compose NÃO disponível"
    ERRORS=$((ERRORS+1))
fi

if command -v node &>/dev/null; then
    pass "Node.js: $(node --version)"
else
    warn "Node.js não encontrado no PATH (necessário para dev local, não para Docker)"
fi

if command -v npm &>/dev/null; then
    pass "npm: $(npm --version)"
else
    warn "npm não encontrado"
fi

# ── 2. ARQUIVO .env ────────────────────────────────────────────────────────
header "2. ARQUIVO .env"

if [ -f .env ]; then
    pass ".env existe"
    
    # Verificar variáveis críticas
    source .env 2>/dev/null || true
    
    if [ -n "${DB_PASSWORD:-}" ] && [ "$DB_PASSWORD" != "govai_dev_db_password" ]; then
        pass "DB_PASSWORD configurado (não é default)"
    elif [ -n "${DB_PASSWORD:-}" ]; then
        warn "DB_PASSWORD usando valor default de dev"
    else
        fail "DB_PASSWORD não definido no .env"
        ERRORS=$((ERRORS+1))
    fi
    
    if [ -n "${GROQ_API_KEY:-}" ] && [[ ! "$GROQ_API_KEY" =~ "your-groq" ]]; then
        pass "GROQ_API_KEY configurada"
    else
        fail "GROQ_API_KEY não configurada — LLM não vai funcionar"
        echo -e "     ${YELLOW}Obtenha em: https://console.groq.com/keys (gratuito)${NC}"
        ERRORS=$((ERRORS+1))
    fi
    
    if [ -n "${SIGNING_SECRET:-}" ]; then
        pass "SIGNING_SECRET definido"
    else
        fail "SIGNING_SECRET não definido"
        ERRORS=$((ERRORS+1))
    fi
    
    if [ -n "${JWT_SECRET:-}" ]; then
        pass "JWT_SECRET definido"
    else
        fail "JWT_SECRET não definido"
        ERRORS=$((ERRORS+1))
    fi
else
    fail ".env NÃO EXISTE — a aplicação não vai funcionar"
    echo -e "     ${YELLOW}Execute: cp .env.example .env${NC}"
    echo -e "     ${YELLOW}Depois edite .env e preencha pelo menos GROQ_API_KEY${NC}"
    ERRORS=$((ERRORS+1))
fi

# ── 3. DOCKER SERVICES ────────────────────────────────────────────────────
header "3. DOCKER SERVICES"

if docker compose ps --format json 2>/dev/null | head -1 | grep -q "Service"; then
    pass "Docker Compose está rodando"
    
    for svc in database redis litellm presidio api admin-ui; do
        status=$(docker compose ps --format "{{.Status}}" "$svc" 2>/dev/null | head -1)
        if echo "$status" | grep -qi "healthy\|running"; then
            pass "$svc: $status"
        elif echo "$status" | grep -qi "starting"; then
            warn "$svc: $status (aguarde...)"
        elif [ -z "$status" ]; then
            fail "$svc: NÃO EXISTE — rode 'docker compose up -d'"
            ERRORS=$((ERRORS+1))
        else
            fail "$svc: $status"
            ERRORS=$((ERRORS+1))
        fi
    done
else
    warn "Docker Compose NÃO está rodando"
    info "Execute: docker compose up -d --build"
    info "Aguarde ~2-3 minutos para todos os serviços ficarem healthy"
fi

# ── 4. ENDPOINTS ──────────────────────────────────────────────────────────
header "4. TESTANDO ENDPOINTS"

# Backend health
if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    pass "Backend API (porta 3000): respondendo"
    health=$(curl -sf http://localhost:3000/health 2>/dev/null)
    echo -e "     $health"
else
    fail "Backend API (porta 3000): NÃO RESPONDE"
    info "Se Docker está rodando, verifique: docker compose logs api"
    ERRORS=$((ERRORS+1))
fi

# Admin UI
if curl -sf http://localhost:3001 >/dev/null 2>&1; then
    pass "Admin UI (porta 3001): respondendo"
else
    fail "Admin UI (porta 3001): NÃO RESPONDE"
    info "Se Docker está rodando, verifique: docker compose logs admin-ui"
    ERRORS=$((ERRORS+1))
fi

# LiteLLM
if curl -sf http://localhost:4000/health >/dev/null 2>&1; then
    pass "LiteLLM (porta 4000): respondendo"
else
    warn "LiteLLM (porta 4000): não responde (necessário para execução de LLM)"
fi

# ── 5. LOGIN TEST ─────────────────────────────────────────────────────────
header "5. TESTE DE LOGIN"

if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    login_result=$(curl -sf -X POST http://localhost:3000/v1/admin/login \
        -H "Content-Type: application/json" \
        -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' 2>/dev/null || echo "FAIL")
    
    if echo "$login_result" | grep -q "token"; then
        pass "Login com credenciais demo: OK"
        info "Email: admin@orga.com"
        info "Senha: GovAI2026@Admin"
    else
        warn "Login demo falhou — seed pode não ter rodado"
        info "Execute: docker compose exec api bash scripts/seed.sh"
        info "Resultado: $login_result"
    fi
else
    info "Pulando teste de login (backend não responde)"
fi

# ── 6. ADMIN UI BUILD ────────────────────────────────────────────────────
header "6. VERIFICAÇÃO DO BUILD DA UI"

if [ -d "admin-ui/.next" ]; then
    pass "admin-ui/.next existe (build feito)"
else
    warn "admin-ui/.next não existe localmente"
    info "Para dev local: cd admin-ui && npm install && npm run build"
fi

# Verificar se as mudanças de UI-2 estão no código
if grep -q "0C0F14" admin-ui/src/app/globals.css 2>/dev/null; then
    pass "Tema warm dark (Sprint UI-2) presente no código"
else
    fail "Tema warm dark NÃO encontrado — globals.css pode estar desatualizado"
    ERRORS=$((ERRORS+1))
fi

if grep -q "mobileOpen" admin-ui/src/components/Sidebar.tsx 2>/dev/null; then
    pass "Sidebar mobile (Sprint UI-2) presente no código"
else
    fail "Sidebar mobile NÃO encontrado"
    ERRORS=$((ERRORS+1))
fi

# ── RESUMO ────────────────────────────────────────────────────────────────
header "RESUMO"

if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}"
    echo "  ╔═══════════════════════════════════════════╗"
    echo "  ║  TUDO OK — Aplicação pronta para uso      ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  Acesse: http://localhost:3001"
    echo "  Login:  admin@orga.com / GovAI2026@Admin"
else
    echo -e "${RED}"
    echo "  ╔═══════════════════════════════════════════╗"
    echo "  ║  $ERRORS PROBLEMA(S) ENCONTRADO(S)        ║"
    echo "  ╚═══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "  PASSOS PARA CORRIGIR:"
    echo ""
    echo "  1. cp .env.example .env"
    echo "  2. Editar .env: preencher GROQ_API_KEY (obter em https://console.groq.com/keys)"
    echo "  3. docker compose down -v  (limpar tudo)"
    echo "  4. docker compose up -d --build  (reconstruir)"
    echo "  5. Aguardar ~3 minutos"
    echo "  6. Rodar este script novamente: ./diagnostico.sh"
    echo ""
    echo "  Se admin-ui mostra visual antigo (preto puro):"
    echo "  → docker compose build admin-ui --no-cache"
    echo "  → docker compose up -d admin-ui"
fi
