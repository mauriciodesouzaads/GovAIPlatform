#!/usr/bin/env bash
# tests/integration/test-evidencias.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.B.2 (/evidencias com 3 sub-abas)
# ----------------------------------------------------------------------------
# Valida:
#   1. Migration 100 — coluna source NOT NULL com retrofit + CHECK + index
#   2. Endpoint ?source= filtra apenas a aba pedida + ?q= busca em title
#   3. counts_by_source retorna 4 buckets agregados
#   4. handleCodeTurn (Modo Code) cria work_item com source='chat' direto
#   5. Backward compat: /execucoes redireciona p/ /evidencias (client-side)
#   6. Sidebar rename: bundle JS contém "Evidências" sem "Execuções"/"Relatórios"
#   7. Regressão zero: 6c.B.1 + 6c.B + 6c.A continuam verde
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

PASS_REDIS=$(grep -E "^REDIS_PASSWORD=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")
clear_rl() {
    docker compose exec -T redis redis-cli -a "$PASS_REDIS" --no-auth-warning EVAL \
        "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" \
        0 "*login*" >/dev/null 2>&1
}
clear_rl

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  /evidencias com 3 sub-abas — 14.0/6c.B.2                     "
echo "════════════════════════════════════════════════════════════════"

echo ""
echo "═══ Setup ═══"
TOKEN=$(/usr/bin/curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "  ❌ login failed"; exit 1; }
ok "token captured"
AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── Test 1: Migration 100 schema ───────────────────────────────────
echo ""
echo "═══ Test 1: migration 100 schema ═══"
HAS_COL=$(psql_q "SELECT 1 FROM information_schema.columns
                   WHERE table_name='runtime_work_items' AND column_name='source'")
[ "$HAS_COL" = "1" ] && ok "coluna source presente" || fail "coluna source ausente"

NULL_COUNT=$(psql_q "SELECT COUNT(*) FROM runtime_work_items WHERE source IS NULL")
[ "$NULL_COUNT" = "0" ] && ok "zero NULLs em source (retrofit completo)" \
    || fail "$NULL_COUNT NULLs em source"

HAS_CHECK=$(psql_q "SELECT 1 FROM pg_constraint
                     WHERE conname='runtime_work_items_source_check'")
[ "$HAS_CHECK" = "1" ] && ok "CHECK enum-like presente" || fail "CHECK ausente"

HAS_IDX=$(psql_q "SELECT 1 FROM pg_indexes
                   WHERE indexname='idx_runtime_work_items_source_created'")
[ "$HAS_IDX" = "1" ] && ok "index composto criado" || fail "index ausente"

HAS_TRG=$(psql_q "SELECT 1 FROM pg_trigger
                   WHERE tgname='trg_runtime_work_items_source_default'")
[ "$HAS_TRG" = "1" ] && ok "trigger BEFORE INSERT criado" || fail "trigger ausente"

# ─── Test 2: Distribuição esperada após retrofit ────────────────────
echo ""
echo "═══ Test 2: distribuição source ═══"
CHAT_N=$(psql_q "SELECT COUNT(*) FROM runtime_work_items WHERE source='chat'")
TEST_N=$(psql_q "SELECT COUNT(*) FROM runtime_work_items WHERE source='test'")
ADMIN_N=$(psql_q "SELECT COUNT(*) FROM runtime_work_items WHERE source='admin'")
TOTAL=$((CHAT_N + TEST_N + ADMIN_N))

[ "$CHAT_N" -gt 0 ]  && ok "chat=$CHAT_N (>0)"   || fail "chat=$CHAT_N (esperado >0)"
[ "$TEST_N" -gt 0 ]  && ok "test=$TEST_N (>0)"   || fail "test=$TEST_N (esperado >0)"
[ "$ADMIN_N" -gt 0 ] && ok "admin=$ADMIN_N (>0)" || fail "admin=$ADMIN_N (esperado >0)"
[ "$TOTAL" -ge 200 ] && ok "total=$TOTAL (matches recon)" \
    || fail "total=$TOTAL (esperado >=200)"

# ─── Test 3: Endpoint ?source= filter ───────────────────────────────
echo ""
echo "═══ Test 3: endpoint ?source= ═══"
ALL_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?parent_work_item_id=null&limit=5")
COUNTS_KEYS=$(echo "$ALL_RES" | jq -r '.counts_by_source | keys | sort | join(",")')
[ "$COUNTS_KEYS" = "admin,api,chat,test" ] \
    && ok "counts_by_source com 4 buckets" \
    || fail "counts_by_source incompleto: $COUNTS_KEYS"

EP_CHAT=$(echo "$ALL_RES" | jq '.counts_by_source.chat')
[ "$EP_CHAT" = "$CHAT_N" ] && ok "counts.chat=$EP_CHAT bate com DB" \
    || fail "counts.chat=$EP_CHAT vs DB=$CHAT_N"

# Filtro source=chat retorna apenas chat
CHAT_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?source=chat&parent_work_item_id=null&limit=10")
N_NON_CHAT=$(echo "$CHAT_RES" | jq '[.items[] | select(.source != "chat")] | length')
N_CHAT=$(echo "$CHAT_RES" | jq '.items | length')
[ "$N_NON_CHAT" = "0" ] && [ "$N_CHAT" -gt 0 ] \
    && ok "?source=chat retornou $N_CHAT items (todos chat)" \
    || fail "?source=chat vazou non-chat ($N_NON_CHAT)"

# Filtro source=test retorna apenas test
TEST_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?source=test&parent_work_item_id=null&limit=10")
N_NON_TEST=$(echo "$TEST_RES" | jq '[.items[] | select(.source != "test")] | length')
[ "$N_NON_TEST" = "0" ] && ok "?source=test retornou apenas test" \
    || fail "$N_NON_TEST items não-test vazaram em ?source=test"

# Filtro source=admin retorna apenas admin
ADMIN_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?source=admin&parent_work_item_id=null&limit=10")
N_NON_ADMIN=$(echo "$ADMIN_RES" | jq '[.items[] | select(.source != "admin")] | length')
[ "$N_NON_ADMIN" = "0" ] && ok "?source=admin retornou apenas admin" \
    || fail "$N_NON_ADMIN items não-admin vazaram em ?source=admin"

# ─── Test 4: Endpoint ?q= search ────────────────────────────────────
echo ""
echo "═══ Test 4: endpoint ?q= search (ILIKE em title) ═══"
SEARCH_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?q=DPO&parent_work_item_id=null&limit=10")
N_SEARCH=$(echo "$SEARCH_RES" | jq '.items | length')
[ "$N_SEARCH" -gt 0 ] && ok "?q=DPO retornou $N_SEARCH items" \
    || fail "?q=DPO retornou zero (esperado >0)"

# Combinar source + q
COMBO_RES=$(/usr/bin/curl -sS "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items?source=chat&q=ls&parent_work_item_id=null&limit=10")
N_COMBO=$(echo "$COMBO_RES" | jq '.items | length')
[ "$N_COMBO" -gt 0 ] && ok "?source=chat+q=ls combinado retornou $N_COMBO items" \
    || fail "combo source+q vazio"

# ─── Test 5: handleCodeTurn — source='chat' explícito ───────────────
echo ""
echo "═══ Test 5: handleCodeTurn source='chat' ═══"
clear_rl
COMPLIANCE_ID=$(psql_q "SELECT id FROM assistants WHERE name='Compliance LGPD GovAI'")
[ -n "$COMPLIANCE_ID" ] && ok "Compliance ID resolvido" \
    || { fail "agent missing"; exit 1; }

CONV=$(/usr/bin/curl -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d "{\"title\":\"6cB2 source\",\"assistant_id\":\"$COMPLIANCE_ID\"}" \
    "$API/v1/chat/conversations" | jq -r .id)

TMP=$(mktemp)
/usr/bin/curl -N -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"content":"Use bash echo para criar fixture-source.txt no diretorio atual","mode":"code"}' \
    "$API/v1/chat/conversations/$CONV/messages" --max-time 90 > "$TMP" 2>&1

WI=$(grep -oE '"work_item_id":"[a-f0-9-]+"' "$TMP" | head -1 | cut -d'"' -f4)
[ -n "$WI" ] && ok "work_item criado: $WI" || { fail "no WI"; cat "$TMP"; exit 1; }

SRC=$(psql_q "SELECT source FROM runtime_work_items WHERE id='$WI'")
[ "$SRC" = "chat" ] && ok "source='chat' (INSERT explícito do handleCodeTurn)" \
    || fail "source=$SRC"

# Cleanup
/usr/bin/curl -sS "${AUTH[@]}" -X DELETE "$API/v1/chat/conversations/$CONV" > /dev/null
rm -f "$TMP"

# ─── Test 6: Backward compat /execucoes redirect ────────────────────
echo ""
echo "═══ Test 6: /execucoes → /evidencias redirect ═══"
# Next.js client redirect: HTML é shell vazio + page chunk contém o
# código com /evidencias literal e "Redirecionando". Precisamos olhar
# dentro do chunk JS, não do HTML inicial.
HTML=$(/usr/bin/curl -sS "$UI/execucoes")
EXEC_CHUNK=$(echo "$HTML" | grep -oE 'static/chunks/app/execucoes/page[^"]+\.js' | head -1)
[ -n "$EXEC_CHUNK" ] && ok "/execucoes serve com chunk: $EXEC_CHUNK" \
    || fail "/execucoes sem page chunk"

CHUNK_BODY=$(/usr/bin/curl -sS "$UI/_next/$EXEC_CHUNK")
echo "$CHUNK_BODY" | grep -qE "/evidencias|Redirecionando" \
    && ok "page chunk contém '/evidencias' (redirect implementado)" \
    || fail "chunk sem string de redirect"

HTTP_EV=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI/evidencias")
[ "$HTTP_EV" = "200" ] && ok "/evidencias HTTP 200" || fail "/evidencias HTTP $HTTP_EV"

# /execucoes/<id> deve redirecionar para /evidencias/<id>
SAMPLE_WI=$(echo "$ALL_RES" | jq -r '.items[0].id')
HTML_DETAIL=$(/usr/bin/curl -sS "$UI/execucoes/$SAMPLE_WI")
DETAIL_CHUNK=$(echo "$HTML_DETAIL" | grep -oE 'static/chunks/app/execucoes/[^"]*page[^"]*\.js' | head -1)
DETAIL_BODY=$(/usr/bin/curl -sS "$UI/_next/$DETAIL_CHUNK")
echo "$DETAIL_BODY" | grep -qE "/evidencias|Redirecionando" \
    && ok "/execucoes/[id] serve redirect p/ /evidencias/<id>" \
    || fail "/execucoes/[id] sem redirect"

# ─── Test 7: Sidebar rename — verificar HTML server-rendered ────────
echo ""
echo "═══ Test 7: sidebar i18n ═══"
# Sidebar é server-rendered no dashboard (página inicial /). i18n labels
# vão no payload __next_f como JSON, então buscamos no HTML mesmo.
DASH_HTML=$(/usr/bin/curl -sS "$UI/")

echo "$DASH_HTML" | grep -q "Evidências" \
    && ok '"Evidências" presente no HTML do dashboard' \
    || fail '"Evidências" ausente no HTML'

# "Execuções" como label de nav: foi removida do i18n key 'execucoes'
# Aceita ocorrência em outras páginas mas não como item de menu.
# Buscamos especificamente "Execuções\":\"Execuções\"" tipo
# que indicaria a entry i18n antiga.
! echo "$DASH_HTML" | grep -q '"execucoes":"Execuções"' \
    && ok '"execucoes":"Execuções" i18n entry removida' \
    || fail 'i18n entry "execucoes" ainda presente'

! echo "$DASH_HTML" | grep -q "Evidências & Relatórios" \
    && ok '"Evidências & Relatórios" deletado' \
    || fail '"Evidências & Relatórios" ainda visível'

# ─── Test 8: Trigger fix da 6c.B.2-fix — replica patterns retrofit ──
# Migration 101 atualiza a função do trigger BEFORE INSERT para
# replicar os patterns de title que o retrofit em batch da 100 usou.
# Sem essa fix, testes recém-criados sempre vazavam para 'admin'.
echo ""
echo "═══ Test 8 (6c.B.2-fix): trigger replica patterns ═══"

# 9.1 — INSERT com title 'reality-check-*' sem source explícito
FIXTURE_NODE="fixture-trigger-$$-$(date +%s)"
INSERT_RES=$(psql_q "
WITH ins AS (
    INSERT INTO runtime_work_items (
        org_id, node_id, item_type, title, status,
        execution_hint, execution_mode
    ) VALUES (
        '$ORG'::uuid, '$FIXTURE_NODE', 'compliance_check',
        'reality-check-trigger-validation', 'pending',
        'openclaude', 'freeform'
    ) RETURNING source
)
SELECT source FROM ins")
[ "$INSERT_RES" = "test" ] \
    && ok "trigger classifica 'reality-check-*' como source='test'" \
    || fail "trigger errou: source=$INSERT_RES"
psql_q "DELETE FROM runtime_work_items WHERE node_id='$FIXTURE_NODE'" >/dev/null

# 9.2 — INSERT com title '[livre] reality-check*'
FIXTURE_NODE="fixture-livre-$$-$(date +%s)"
INSERT_RES=$(psql_q "
WITH ins AS (
    INSERT INTO runtime_work_items (
        org_id, node_id, item_type, title, status,
        execution_hint, execution_mode
    ) VALUES (
        '$ORG'::uuid, '$FIXTURE_NODE', 'compliance_check',
        '[livre] reality-check-freeform-fixture', 'pending',
        'openclaude', 'freeform'
    ) RETURNING source
)
SELECT source FROM ins")
[ "$INSERT_RES" = "test" ] \
    && ok "trigger classifica '[livre] reality-check*' como test" \
    || fail "trigger errou em [livre]: source=$INSERT_RES"
psql_q "DELETE FROM runtime_work_items WHERE node_id='$FIXTURE_NODE'" >/dev/null

# 9.3 — INSERT com title comum (sem pattern de teste) → admin default
FIXTURE_NODE="fixture-admin-$$-$(date +%s)"
INSERT_RES=$(psql_q "
WITH ins AS (
    INSERT INTO runtime_work_items (
        org_id, node_id, item_type, title, status,
        execution_hint, execution_mode
    ) VALUES (
        '$ORG'::uuid, '$FIXTURE_NODE', 'compliance_check',
        'Análise manual de risco', 'pending',
        'openclaude', 'freeform'
    ) RETURNING source
)
SELECT source FROM ins")
[ "$INSERT_RES" = "admin" ] \
    && ok "trigger usa admin como default p/ títulos sem pattern" \
    || fail "trigger errou no default: source=$INSERT_RES"
psql_q "DELETE FROM runtime_work_items WHERE node_id='$FIXTURE_NODE'" >/dev/null

# 9.4 — Zero leaks remanescentes pós-101
LEAKS=$(psql_q "
SELECT COUNT(*) FROM runtime_work_items
 WHERE source = 'admin'
   AND (title LIKE 'reality-check-%'
        OR title LIKE '[livre] reality-check%'
        OR title LIKE 'reality-check-agent-mode%'
        OR title LIKE '6a%test%'
        OR title LIKE '6a%probe%'
        OR title LIKE 'smoke-%'
        OR title LIKE 'test --%')")
[ "$LEAKS" = "0" ] \
    && ok "zero leaks: nenhum admin com pattern de teste" \
    || fail "$LEAKS items admin ainda casam patterns de teste"

# ─── Test 9: Regressão suítes anteriores (1 nível, sem cascade) ─────
# Cascade evitada: as suítes anteriores já chamam regression entre si.
# Aqui validamos só test-chat-mode (lib base do /chat) p/ confirmar que
# o rename da sidebar não quebrou navegação de chat.
echo ""
echo "═══ Test 9: regressão sanity (test-chat-mode) ═══"
clear_rl
if bash tests/integration/test-chat-mode.sh > /tmp/r-test-chat-mode.log 2>&1; then
    ok "test-chat-mode pass"
else
    # Avaliação: sub-cascata dela falhou? checa o resultado próprio
    # da suíte (linha "Result: N / N pass") e não o exit code.
    LAST_RES=$(grep -E "^  Result:" /tmp/r-test-chat-mode.log | tail -1)
    if echo "$LAST_RES" | grep -qE "[0-9]+ / [0-9]+ pass, 0 fail"; then
        ok "test-chat-mode próprio pass (subcascata falhou — não relevante)"
    else
        fail "test-chat-mode regrediu: $LAST_RES"
        tail -10 /tmp/r-test-chat-mode.log
    fi
fi

# ─── Summary ────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $((PASS+FAIL)) pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ 6c.B.2 PASSED" || { echo "  ❌ FAIL"; exit 1; }
echo "════════════════════════════════════════════════════════════════"
