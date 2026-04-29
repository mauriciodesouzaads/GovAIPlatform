#!/usr/bin/env bash
# tests/integration/test-chat-code-mode.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.B (Modo Code dentro de /chat)
# ----------------------------------------------------------------------------
# Verifica:
#   1. Migration 099 aplicada — chat_messages.mode com CHECK e index
#   2. POST /messages com mode='code' dispatcha workItem real (5b.2)
#      e emite envelope mode_code_started + RUN_STARTED + RUN_COMPLETED
#   3. Persistência: chat_messages.mode='code' + work_item_id linkado +
#      content com texto final + metadata.tool_count
#   4. Bidirecional: runtime_work_items.execution_context tem
#      source='chat' + conversation_id + chat_user_message_id
#   5. Default sem mode = chat (regressão 6c.A)
#   6. UI rota /chat/:id continua 200 mesmo em conversas com turn code
#   7. Regressão: test-chat-mode (6c.A) ainda passa
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Chat modo Code — 14.0/6c.B                                    "
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

# ─── Test 1: migration 099 ─────────────────────────────────────────
echo ""
echo "═══ Test 1: migration 099 ═══"
N=$(psql_q "SELECT COUNT(*) FROM information_schema.columns
            WHERE table_name='chat_messages' AND column_name='mode'")
[ "$N" = "1" ] && ok "chat_messages.mode existe" || fail "coluna ausente"

N=$(psql_q "SELECT COUNT(*) FROM pg_constraint
            WHERE conname='chat_messages_mode_check'")
[ "$N" = "1" ] && ok "CHECK constraint criada" || fail "CHECK ausente"

N=$(psql_q "SELECT COUNT(*) FROM pg_indexes
            WHERE indexname='idx_chat_msg_mode'")
[ "$N" = "1" ] && ok "index idx_chat_msg_mode criado" || fail "index ausente"

# ─── Test 2: POST /messages mode='code' end-to-end ─────────────────
echo ""
echo "═══ Test 2: dispatch real via mode='code' ═══"

CONV=$(/usr/bin/curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"title":"Reality-check 6c.B"}' \
    "$API/v1/chat/conversations" | jq -r .id)
[ -n "$CONV" ] && [ "$CONV" != "null" ] && ok "conversation criada $CONV" \
    || { fail "create falhou"; exit 1; }

TMP=$(mktemp)
/usr/bin/curl -N -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"content":"Use o comando ls para listar arquivos no diretório atual.","mode":"code"}' \
    "$API/v1/chat/conversations/$CONV/messages" --max-time 90 > "$TMP" 2>&1

grep -q '"type":"mode_code_started"' "$TMP" \
    && ok "envelope mode_code_started emitido" \
    || fail "mode_code_started ausente"

grep -q '"type":"RUN_STARTED"' "$TMP" \
    && ok "RUN_STARTED forwarded" \
    || fail "RUN_STARTED ausente"

grep -q '"type":"RUN_COMPLETED"' "$TMP" \
    && ok "RUN_COMPLETED forwarded" \
    || fail "RUN_COMPLETED ausente"

grep -q '"type":"TOOL_START"' "$TMP" \
    && ok "TOOL_START forwarded" \
    || fail "TOOL_START ausente (esperava Bash)"

grep -q '"type":"done"' "$TMP" \
    && ok "envelope done emitido" \
    || fail "done ausente"

WI=$(grep -o '"work_item_id":"[^"]*"' "$TMP" | head -1 | sed 's/"work_item_id":"//;s/"$//')
[ -n "$WI" ] && ok "work_item_id capturado: ${WI:0:8}..." || fail "work_item_id ausente"

# ─── Test 3: persistência chat_messages ────────────────────────────
echo ""
echo "═══ Test 3: persistência ═══"

# Aguardar persistência final (RUN_COMPLETED → persistAssistantFromWorkItem é
# síncrono dentro do handler antes do done envelope, então quando o stream
# fecha já foi persistido; nenhum sleep necessário).
ASST_MODE=$(psql_q "SELECT mode FROM chat_messages
                     WHERE conversation_id='$CONV' AND role='assistant'")
[ "$ASST_MODE" = "code" ] && ok "assistant.mode = code" \
    || fail "assistant.mode = $ASST_MODE"

ASST_WI=$(psql_q "SELECT work_item_id FROM chat_messages
                   WHERE conversation_id='$CONV' AND role='assistant'")
[ "$ASST_WI" = "$WI" ] && ok "assistant.work_item_id = work_item_id do stream" \
    || fail "work_item_id divergente: db=$ASST_WI stream=$WI"

LEN=$(psql_q "SELECT LENGTH(content) FROM chat_messages
                WHERE conversation_id='$CONV' AND role='assistant'")
[ "$LEN" -gt 20 ] && ok "content persistido ($LEN chars)" \
    || fail "content vazio (len=$LEN)"

TOOL_COUNT=$(psql_q "SELECT (metadata->>'tool_count')::int FROM chat_messages
                      WHERE conversation_id='$CONV' AND role='assistant'")
[ "$TOOL_COUNT" -ge 1 ] && ok "metadata.tool_count = $TOOL_COUNT" \
    || fail "metadata.tool_count ausente ou zero"

# ─── Test 4: bidirecional runtime_work_items ───────────────────────
echo ""
echo "═══ Test 4: link bidirecional via execution_context ═══"

SOURCE=$(psql_q "SELECT execution_context->>'source'
                   FROM runtime_work_items WHERE id='$WI'")
[ "$SOURCE" = "chat" ] && ok "execution_context.source = chat" \
    || fail "source = $SOURCE"

CTX_CONV=$(psql_q "SELECT execution_context->>'conversation_id'
                     FROM runtime_work_items WHERE id='$WI'")
[ "$CTX_CONV" = "$CONV" ] && ok "execution_context.conversation_id linkado" \
    || fail "conversation_id divergente: $CTX_CONV"

CTX_USER_MSG=$(psql_q "SELECT (execution_context->>'chat_user_message_id') IS NOT NULL
                         FROM runtime_work_items WHERE id='$WI'")
[ "$CTX_USER_MSG" = "t" ] && ok "execution_context.chat_user_message_id presente" \
    || fail "chat_user_message_id ausente"

# ─── Test 5: default = chat (regressão 6c.A) ───────────────────────
echo ""
echo "═══ Test 5: default sem mode = chat (regressão 6c.A) ═══"

CONV2=$(/usr/bin/curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"title":"Reality-check 6c.B - chat default"}' \
    "$API/v1/chat/conversations" | jq -r .id)

TMP2=$(mktemp)
/usr/bin/curl -N -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"content":"Diga apenas: oi","model":"claude-haiku-4-5"}' \
    "$API/v1/chat/conversations/$CONV2/messages" --max-time 60 > "$TMP2" 2>&1

# Sem mode no body → handler clássico → emite delta + done (não mode_code_started)
grep -q '"type":"delta"' "$TMP2" \
    && ok "delta emitido (handler chat clássico)" \
    || fail "delta ausente — handler chat regrediu"

! grep -q '"type":"mode_code_started"' "$TMP2" \
    && ok "mode_code_started NÃO emitido (correto p/ default chat)" \
    || fail "mode_code_started emitido sem pedido — bug"

CONV2_MODE=$(psql_q "SELECT mode FROM chat_messages
                       WHERE conversation_id='$CONV2' AND role='assistant'")
[ "$CONV2_MODE" = "chat" ] && ok "mode persistido como chat (default)" \
    || fail "mode = $CONV2_MODE (esperava chat)"

rm -f "$TMP" "$TMP2"

# ─── Test 6: UI rota ───────────────────────────────────────────────
echo ""
echo "═══ Test 6: UI rota /chat/:id ═══"
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI/chat/$CONV")
[ "$HTTP" = "200" ] && ok "/chat/<conv-com-code> → 200" || fail "HTTP $HTTP"

# Cleanup
/usr/bin/curl -sS -X DELETE "${AUTH[@]}" "$API/v1/chat/conversations/$CONV"  > /dev/null
/usr/bin/curl -sS -X DELETE "${AUTH[@]}" "$API/v1/chat/conversations/$CONV2" > /dev/null

# ─── Test 7: regressão 6c.A ────────────────────────────────────────
echo ""
echo "═══ Test 7: regressão (6c.A) ═══"
if bash tests/integration/test-chat-mode.sh > /tmp/r6ca.log 2>&1; then
    ok "test-chat-mode (6c.A) PASSED"
else
    fail "test-chat-mode regrediu — see /tmp/r6ca.log"
    tail -10 /tmp/r6ca.log
fi

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Chat code mode PASSED — 6c.B end-to-end" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
