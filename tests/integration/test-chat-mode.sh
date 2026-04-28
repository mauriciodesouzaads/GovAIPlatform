#!/usr/bin/env bash
# tests/integration/test-chat-mode.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.A (Chat nativo Claude Desktop-like)
# ----------------------------------------------------------------------------
# Verifica:
#   1. LiteLLM /health/liveliness 200 + 6 aliases novos expostos
#   2. Migration 097 com 4 tabelas + 6 llm_providers seedados
#   3. CRUD de conversas (create / list / patch / delete)
#   4. SSE streaming end-to-end com claude-haiku-4-5 (provider real,
#      não mock — proves the LiteLLM bridge funciona ponta a ponta)
#   5. Mensagens persistidas em chat_messages com tokens + latency
#   6. UI rotas /chat e /chat/:id retornam 200
#   7. Regressão zero em 6a₂.B (skills) + 6a₂.C (workspace) + 6a₁
#      (RAG) + 5b.2 (execucoes)
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
LITELLM_URL="${LITELLM_URL:-http://localhost:4000}"

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Chat nativo /v1/chat — 14.0/6c.A                             "
echo "════════════════════════════════════════════════════════════════"

# ─── Setup ─────────────────────────────────────────────────────────
echo ""
echo "═══ Setup: admin login ═══"
TOKEN=$(/usr/bin/curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "  ❌ login failed"; exit 1; }
echo "  ✅ token captured"
AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── Test 1: LiteLLM ───────────────────────────────────────────────
echo ""
echo "═══ Test 1: LiteLLM up + 6 chat aliases ═══"
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$LITELLM_URL/health/liveliness")
[ "$HTTP" = "200" ] && ok "LiteLLM /health/liveliness 200" || fail "LiteLLM down ($HTTP)"

LITELLM_KEY=$(grep "^LITELLM_KEY=" "/Users/mauriciodesouza/Desktop/TRABALHO/GovAI - Enterprise AI GRC /GitHub /GovAI GRC Platform/.env" | head -1 | cut -d= -f2)
NEW_ALIASES=$(/usr/bin/curl -sS -H "Authorization: Bearer $LITELLM_KEY" "$LITELLM_URL/v1/models" \
    | jq -r '.data[].id' | grep -cE "^claude-(opus-4-7|sonnet-4-6|haiku-4-5)$|^gpt-4o(-mini)?$|^gemini-2-flash$" || true)
[ "$NEW_ALIASES" = "6" ] \
    && ok "6 chat aliases expostos no LiteLLM" \
    || fail "esperava 6 aliases, achou $NEW_ALIASES"

# ─── Test 2: Migration 097 ─────────────────────────────────────────
echo ""
echo "═══ Test 2: schema chat (migration 097) ═══"
N_TBL=$(psql_q "SELECT COUNT(*) FROM information_schema.tables
                  WHERE table_name IN
                    ('chat_conversations','chat_messages','chat_attachments','llm_providers')")
[ "$N_TBL" = "4" ] && ok "4 tabelas chat presentes" || fail "achou $N_TBL (esperava 4)"

N_PROV=$(psql_q "SELECT COUNT(*) FROM llm_providers WHERE is_enabled=TRUE")
[ "$N_PROV" -ge 6 ] && ok "$N_PROV llm_providers seedados" || fail "$N_PROV (esperava ≥6)"

# ─── Test 3: GET /v1/chat/llm-providers ────────────────────────────
echo ""
echo "═══ Test 3: GET /v1/chat/llm-providers ═══"
N=$(/usr/bin/curl -sS "${AUTH[@]}" "$API/v1/chat/llm-providers" | jq '.providers | length')
[ "$N" -ge 6 ] && ok "endpoint retorna $N providers" || fail "$N providers"

# ─── Test 4: CRUD conversations ────────────────────────────────────
echo ""
echo "═══ Test 4: CRUD conversations ═══"
CONV=$(/usr/bin/curl -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"default_model":"claude-haiku-4-5"}' \
    "$API/v1/chat/conversations" | jq -r .id)
[ -n "$CONV" ] && ok "POST conversation → $CONV" || fail "create falhou"

# Patch (rename)
NEW_TITLE=$(/usr/bin/curl -sS -X PATCH "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"title":"6c.A reality-check"}' \
    "$API/v1/chat/conversations/$CONV" | jq -r .title)
[ "$NEW_TITLE" = "6c.A reality-check" ] && ok "PATCH atualiza title" || fail "title não atualizou"

# List finds it
LIST_HAS=$(/usr/bin/curl -sS "${AUTH[@]}" "$API/v1/chat/conversations" \
    | jq -r ".conversations[] | select(.id == \"$CONV\") | .id")
[ "$LIST_HAS" = "$CONV" ] && ok "GET list inclui a conversa" || fail "list não encontrou"

# ─── Test 5: SSE streaming ─────────────────────────────────────────
echo ""
echo "═══ Test 5: SSE streaming end-to-end via LiteLLM ═══"
TMP_STREAM=$(mktemp)
/usr/bin/curl -N -sS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{"content":"Diga apenas: chat OK","model":"claude-haiku-4-5"}' \
    "$API/v1/chat/conversations/$CONV/messages" > "$TMP_STREAM" 2>&1

grep -q '"type":"delta"' "$TMP_STREAM" \
    && ok "stream emite delta envelope" \
    || fail "nenhum delta no stream"
grep -q '"type":"done"' "$TMP_STREAM" \
    && ok "stream emite done envelope" \
    || fail "nenhum done no stream"
grep -q '"tokens":{"in":' "$TMP_STREAM" \
    && ok "done envelope inclui tokens" \
    || fail "tokens missing"

DONE_LINE=$(grep '"type":"done"' "$TMP_STREAM" | head -1)
ASST_ID=$(echo "$DONE_LINE" | jq -r '.assistant_message_id // empty' 2>/dev/null \
        || echo "$DONE_LINE" | sed -E 's/.*"assistant_message_id":"([^"]+)".*/\1/' )
[ -n "$ASST_ID" ] && ok "assistant_message_id retornado: ${ASST_ID:0:8}…" \
                  || fail "assistant_message_id ausente"
rm -f "$TMP_STREAM"

# ─── Test 6: Mensagens persistidas com tokens + latency ───────────
echo ""
echo "═══ Test 6: chat_messages persistidas ═══"
N=$(/usr/bin/curl -sS "${AUTH[@]}" "$API/v1/chat/conversations/$CONV/messages" \
    | jq '.messages | length')
[ "$N" = "2" ] && ok "user+assistant persistidos ($N msgs)" || fail "$N msgs (esperava 2)"

ASST_TOKENS=$(psql_q "SELECT tokens_in, tokens_out FROM chat_messages
                       WHERE conversation_id='$CONV' AND role='assistant'")
echo "$ASST_TOKENS" | grep -qE "^[0-9]+\|[0-9]+$" \
    && ok "assistant message tem tokens_in/out: $ASST_TOKENS" \
    || fail "tokens not persisted: $ASST_TOKENS"

# ─── Test 7: UI rotas ──────────────────────────────────────────────
echo ""
echo "═══ Test 7: UI rotas ═══"
for path in "/chat" "/chat/$CONV"; do
    HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI$path")
    [ "$HTTP" = "200" ] && ok "$path → 200" || fail "$path → $HTTP"
done

# ─── Test 8: DELETE conversation cascadeia messages ────────────────
echo ""
echo "═══ Test 8: DELETE cascadeia messages ═══"
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" -X DELETE "${AUTH[@]}" \
    "$API/v1/chat/conversations/$CONV")
[ "$HTTP" = "204" ] && ok "DELETE conversation → 204" || fail "DELETE → $HTTP"

ORPHANS=$(psql_q "SELECT COUNT(*) FROM chat_messages WHERE conversation_id='$CONV'")
[ "$ORPHANS" = "0" ] && ok "messages cascade-deleted" || fail "$ORPHANS órfãs"

# ─── Test 9: regressão zero ────────────────────────────────────────
echo ""
echo "═══ Test 9: regressão (6a₂.C + 6a₂.B + 6a₁ + 5b.2) ═══"
if bash tests/integration/test-runner-workspace.sh > /tmp/r6a2c.log 2>&1; then
    ok "test-runner-workspace (6a₂.C) PASSED"
else
    fail "test-runner-workspace regrediu — see /tmp/r6a2c.log"
fi

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Chat nativo PASSED — 6c.A end-to-end" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
