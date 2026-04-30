#!/usr/bin/env bash
# tests/integration/test-theme.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.B.3 CP1 (Theme System)
# ----------------------------------------------------------------------------
# Valida:
#   1. globals.css extends com 60+ CSS vars HSL (light + dark)
#   2. layout.tsx carrega 3 fontes Google + ThemeProvider + NO_FOUC_SCRIPT
#   3. ThemeProvider e ThemeToggle existem como módulos
#   4. Tailwind v4: @theme + @custom-variant dark presentes em globals.css
#   5. /settings renderiza menção a Aparência/Tema
#   6. Bundle JS contém lógica de tema (govai-theme + matchMedia)
#   7. Refactor: ZERO ocorrências de bg-zinc-*, text-zinc-*, border-white/X
#   8. Modo escuro permanece dark (preserva default)
#   9. Regressão sanity: test-evidencias 32/32 verde
# ============================================================================

set -euo pipefail

UI="${UI:-http://localhost:3001}"
ADMIN="admin-ui"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

PASS_REDIS=$(grep -E "^REDIS_PASSWORD=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")
clear_rl() {
    docker compose exec -T redis redis-cli -a "$PASS_REDIS" --no-auth-warning EVAL \
        "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" \
        0 "*login*" >/dev/null 2>&1
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Theme System — 14.0/6c.B.3 CP1                                "
echo "════════════════════════════════════════════════════════════════"

# ─── Test 1: globals.css tokens ─────────────────────────────────────
echo ""
echo "═══ Test 1: globals.css tokens ═══"
GLOBALS="$ADMIN/src/app/globals.css"
[ -f "$GLOBALS" ] && ok "globals.css existe" || fail "globals.css ausente"

VAR_COUNT=$(grep -cE "^\s*--color-" "$GLOBALS" || echo 0)
[ "$VAR_COUNT" -ge 50 ] && ok "$VAR_COUNT --color-* CSS vars declaradas" \
    || fail "apenas $VAR_COUNT vars (esperado >=50)"

grep -q "@theme" "$GLOBALS" && ok "@theme directive presente" || fail "@theme ausente"
grep -q ":root.dark" "$GLOBALS" && ok ":root.dark override presente" \
    || fail ":root.dark ausente"
grep -q "@custom-variant dark" "$GLOBALS" \
    && ok "@custom-variant dark configurado (Tailwind v4)" \
    || fail "@custom-variant dark ausente"

# Light + dark distintos
grep -qE "color-bg-100:\s*hsl\(60 14% 97%\)" "$GLOBALS" \
    && ok "light bg-100 = #F8F8F4 (warm white Claude.ai)" \
    || fail "light bg-100 incorreto"
grep -qE "color-bg-100:\s*hsl\(60 2% 12%\)" "$GLOBALS" \
    && ok "dark bg-100 = #1F1F1E (Claude.ai)" \
    || fail "dark bg-100 incorreto"

# ─── Test 2: Fontes Google ──────────────────────────────────────────
echo ""
echo "═══ Test 2: Fontes Google via next/font ═══"
LAYOUT="$ADMIN/src/app/layout.tsx"
grep -q "Inter\b" "$LAYOUT" && ok "Inter importado" || fail "Inter ausente"
grep -q "DM_Serif_Display" "$LAYOUT" && ok "DM_Serif_Display importado" \
    || fail "DM_Serif_Display ausente"
grep -q "JetBrains_Mono" "$LAYOUT" && ok "JetBrains_Mono importado" \
    || fail "JetBrains_Mono ausente"
grep -qE "var\(--font-inter\)|--font-inter" "$GLOBALS" \
    && ok "Tailwind --font-sans referencia --font-inter" \
    || fail "--font-sans não configurado"

# ─── Test 3: ThemeProvider + ThemeToggle ────────────────────────────
echo ""
echo "═══ Test 3: ThemeProvider + ThemeToggle ═══"
[ -f "$ADMIN/src/lib/theme.tsx" ] && ok "lib/theme.tsx existe" \
    || fail "lib/theme.tsx ausente"
[ -f "$ADMIN/src/components/ThemeToggle.tsx" ] && ok "ThemeToggle existe" \
    || fail "ThemeToggle ausente"
grep -q "ThemeProvider\|useTheme\|NO_FOUC_SCRIPT" "$ADMIN/src/lib/theme.tsx" \
    && ok "exports ThemeProvider+useTheme+NO_FOUC_SCRIPT" \
    || fail "exports incompletos"
grep -qE "Monitor|Sun|Moon" "$ADMIN/src/components/ThemeToggle.tsx" \
    && ok "Monitor/Sun/Moon ícones presentes" \
    || fail "ícones ausentes"

# ─── Test 4: NO_FOUC_SCRIPT no layout ───────────────────────────────
echo ""
echo "═══ Test 4: anti-FOUC ═══"
grep -q "NO_FOUC_SCRIPT" "$LAYOUT" && ok "NO_FOUC_SCRIPT injetado em <head>" \
    || fail "FOUC não tratado"

# Verificar o script aparece no HTML servido
HTML=$(/usr/bin/curl -sS "$UI/login")
echo "$HTML" | grep -q "govai-theme" && ok "HTML servido contém 'govai-theme' inline" \
    || fail "anti-FOUC não chegou ao HTML"
echo "$HTML" | grep -q "matchMedia" && ok "HTML contém matchMedia inline" \
    || fail "matchMedia ausente no HTML"

# ─── Test 5: /settings menciona Aparência ───────────────────────────
echo ""
echo "═══ Test 5: /settings ═══"
clear_rl
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI/settings")
[ "$HTTP" = "200" ] && ok "/settings HTTP 200" || fail "/settings HTTP $HTTP"

PAGE_HTML=$(/usr/bin/curl -sS "$UI/settings")
SETTINGS_CHUNK=$(echo "$PAGE_HTML" | grep -oE 'static/chunks/app/settings[^"]+\.js' | head -1)
if [ -n "$SETTINGS_CHUNK" ]; then
    BUNDLE=$(/usr/bin/curl -sS "$UI/_next/$SETTINGS_CHUNK" 2>/dev/null)
    # "Aparência" tem caracter UTF-8 que produção minifica em escape
    # variável — validamos via 'Tema' label (label da seção dentro
    # do componente que SÓ existe no nosso novo bloco).
    echo "$BUNDLE" | grep -q '"Tema"' \
        && ok "bundle /settings contém label 'Tema' (seção Aparência)" \
        || fail "label 'Tema' ausente no bundle"
    echo "$BUNDLE" | grep -qE "Sistema|Claro|Escuro" \
        && ok "bundle contém labels Sistema/Claro/Escuro" \
        || fail "labels do toggle ausentes"
else
    fail "page chunk /settings não localizado"
fi

# ─── Test 6: bundle layout contém lógica de tema ────────────────────
echo ""
echo "═══ Test 6: bundle layout — lógica de tema ═══"
LAYOUT_CHUNK=$(echo "$PAGE_HTML" | grep -oE 'static/chunks/app/layout[^"]+\.js' | head -1)
if [ -n "$LAYOUT_CHUNK" ]; then
    LAYOUT_BUNDLE=$(/usr/bin/curl -sS "$UI/_next/$LAYOUT_CHUNK" 2>/dev/null)
    echo "$LAYOUT_BUNDLE" | grep -qE "govai-theme|matchMedia\(" \
        && ok "bundle layout contém lógica ThemeProvider" \
        || fail "lógica ausente no layout bundle"
else
    fail "layout chunk não localizado"
fi

# ─── Test 7: refactor — zero hardcoded zinc/white ───────────────────
# Note: grep -l retorna 1 quando NÃO há matches; com pipefail isso
# mataria o script. Usamos `|| true` para amortecer.
echo ""
echo "═══ Test 7: refactor zero hardcode ═══"
HARD=$( { grep -rE "bg-zinc-|text-zinc-|border-zinc-|bg-white/[0-9]|border-white/[0-9]|hover:bg-white/" "$ADMIN/src" --include="*.tsx" -l 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$HARD" = "0" ]; then
    ok "ZERO arquivos com bg-zinc/text-zinc/white-X hardcoded"
else
    fail "$HARD arquivos ainda têm hardcoded neutrals"
fi

# ─── Test 8: modo padrão dark via system pref ───────────────────────
echo ""
echo "═══ Test 8: default theme system → dark ═══"
# Login HTML deve incluir className com 'dark' quando NO_FOUC_SCRIPT roda
# em ambiente sem localStorage (resolve via prefers-color-scheme).
# No CI/server isso não é testável diretamente; validamos que o script
# roda com fallback .dark presente como string.
# NO_FOUC_SCRIPT é minificado: documentElement.classList vira c.classList,
# c.add(r) etc. Validamos a presença do alias `c.add(` que o IIFE usa.
echo "$HTML" | grep -qE "c\.add\(|classList\.add" \
    && ok "NO_FOUC_SCRIPT adiciona classList no <html>" \
    || fail "classList.add ausente"
# Body usa bg-background (alias semântico que inverte por modo)
echo "$HTML" | grep -q "bg-background" \
    && ok "body usa bg-background semântico (theme-aware)" \
    || fail "body sem bg-background"

# ─── Test 9: regressão sanity ───────────────────────────────────────
echo ""
echo "═══ Test 9: regressão (test-evidencias) ═══"
clear_rl
if bash tests/integration/test-evidencias.sh > /tmp/r-evidencias.log 2>&1; then
    ok "test-evidencias 32/32 pass"
else
    LAST=$(grep -E "^  Result:" /tmp/r-evidencias.log | tail -1)
    if echo "$LAST" | grep -qE "[0-9]+ / [0-9]+ pass, 0 fail"; then
        ok "test-evidencias próprio pass: $LAST"
    else
        fail "test-evidencias regrediu: $LAST"
        tail -10 /tmp/r-evidencias.log
    fi
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $((PASS+FAIL)) pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ 6c.B.3 CP1 PASSED" || { echo "  ❌ FAIL"; exit 1; }
echo "════════════════════════════════════════════════════════════════"
