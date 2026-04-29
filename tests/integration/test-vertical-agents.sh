#!/usr/bin/env bash
# tests/integration/test-vertical-agents.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.A.1 (Agentes verticais + vínculo Catálogo↔Chat)
# ----------------------------------------------------------------------------
# Verifica:
#   1. Migration 098 com 9 colunas novas
#   2. 4 agentes verticais com system_prompt > 1500 chars + categoria correta
#   3. 4 KBs seedadas com docs status=ready
#   4. Vínculo assistant ↔ KB ativo via assistant_knowledge_bases
#   5. Vínculo assistant ↔ skill via assistant_skill_bindings
#   6. POST /v1/chat/conversations com assistant_id persiste corretamente,
#      title herda nome do agente, default_model herda do agente
#   7. POST /v1/chat/conversations/:id/messages — pergunta jurídica gera
#      resposta que cita LGPD via RAG retrieval real
#   8. retrieval_log tem entrada da chat conversation
#   9. UI rotas /chat?assistant_id=X e /chat/:id retornam 200
#  10. Regressão zero em 6c.A + 6a₂.C + 6a₂.B + 6a₁ + 5b.2
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
echo "  Agentes verticais + vínculo Catálogo↔Chat — 14.0/6c.A.1      "
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

# ─── Test 1: Migration 098 ─────────────────────────────────────────
echo ""
echo "═══ Test 1: migration 098 — 9 colunas novas ═══"
N=$(psql_q "SELECT COUNT(*) FROM information_schema.columns
            WHERE (table_name='chat_conversations' AND column_name='assistant_id')
               OR (table_name='chat_messages' AND column_name='work_item_id')
               OR (table_name='assistants' AND column_name IN
                   ('system_prompt','category','default_engine','default_model',
                    'default_temperature','avatar_emoji','suggested_prompts'))")
[ "$N" = "9" ] && ok "9 colunas presentes" || fail "$N (esperava 9)"

# ─── Test 2: 4 agentes verticais com system_prompt rico ────────────
echo ""
echo "═══ Test 2: 4 agentes verticais ═══"
for entry in \
    "Assistente Jurídico GovAI|juridico" \
    "Compliance LGPD GovAI|compliance" \
    "Análise de Crédito GovAI|financeiro" \
    "Assistente RH GovAI|rh" \
; do
    name="${entry%|*}"
    cat="${entry#*|}"
    LEN=$(psql_q "SELECT COALESCE(LENGTH(system_prompt), 0) FROM assistants WHERE name='$name'")
    GOT_CAT=$(psql_q "SELECT category FROM assistants WHERE name='$name'")
    if [ "$LEN" -gt 1500 ] && [ "$GOT_CAT" = "$cat" ]; then
        ok "$name sp=$LEN cat=$GOT_CAT"
    else
        fail "$name sp=$LEN cat=$GOT_CAT (esperava >1500 + $cat)"
    fi
done

# ─── Test 3: KBs seedadas ──────────────────────────────────────────
echo ""
echo "═══ Test 3: KBs seedadas com docs ready ═══"
for kb_name in \
    "Base Jurídica Brasileira" \
    "Compliance LGPD Detalhado" \
    "Normativos BACEN + Análise Financeira" \
    "Manual RH GovAI" \
; do
    DOCS=$(psql_q "SELECT COUNT(*) FROM documents d
                     JOIN knowledge_bases k ON d.knowledge_base_id=k.id
                    WHERE k.name='$kb_name' AND d.extraction_status='ready'")
    if [ "$DOCS" -ge 3 ]; then
        ok "$kb_name: $DOCS docs ready"
    else
        fail "$kb_name: apenas $DOCS docs ready"
    fi
done

# ─── Test 4: vínculo assistant↔KB ─────────────────────────────────
echo ""
echo "═══ Test 4: vínculo assistant ↔ KB ═══"
for name in \
    "Assistente Jurídico GovAI" \
    "Compliance LGPD GovAI" \
    "Análise de Crédito GovAI" \
    "Assistente RH GovAI" \
; do
    N=$(psql_q "SELECT COUNT(*) FROM assistant_knowledge_bases akb
                  JOIN assistants a ON akb.assistant_id=a.id
                 WHERE a.name='$name' AND akb.enabled=TRUE")
    [ "$N" -ge 1 ] && ok "$name → $N KB(s)" || fail "$name sem KB"
done

# ─── Test 5: vínculo assistant↔skill ──────────────────────────────
echo ""
echo "═══ Test 5: vínculo assistant ↔ skill ═══"
for name in \
    "Assistente Jurídico GovAI" \
    "Compliance LGPD GovAI" \
    "Análise de Crédito GovAI" \
    "Assistente RH GovAI" \
; do
    N=$(psql_q "SELECT COUNT(*) FROM assistant_skill_bindings asb
                  JOIN assistants a ON asb.assistant_id=a.id
                 WHERE a.name='$name' AND asb.is_active=TRUE")
    [ "$N" -ge 1 ] && ok "$name → $N skill(s)" || fail "$name sem skill"
done

# ─── Test 6: POST /conversations com assistant_id ──────────────────
echo ""
echo "═══ Test 6: POST /conversations com assistant_id ═══"
ASSIST_JURI=$(psql_q "SELECT id FROM assistants WHERE name='Assistente Jurídico GovAI'")

CONV_RESP=$(/usr/bin/curl -sS -X POST "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"assistant_id\":\"$ASSIST_JURI\"}" \
    "$API/v1/chat/conversations")
CONV=$(echo "$CONV_RESP" | jq -r '.id // empty')
[ -n "$CONV" ] && ok "conversation criada $CONV" || { fail "create falhou: $CONV_RESP"; exit 1; }

LINKED=$(psql_q "SELECT assistant_id FROM chat_conversations WHERE id='$CONV'")
[ "$LINKED" = "$ASSIST_JURI" ] && ok "assistant_id persistido" || fail "assistant_id=$LINKED esperava $ASSIST_JURI"

INHERITED_TITLE=$(echo "$CONV_RESP" | jq -r .title)
[ "$INHERITED_TITLE" = "Assistente Jurídico GovAI" ] \
    && ok "title herda nome do agente: $INHERITED_TITLE" \
    || fail "title=$INHERITED_TITLE"

INHERITED_MODEL=$(echo "$CONV_RESP" | jq -r .default_model)
[ "$INHERITED_MODEL" = "claude-sonnet-4-6" ] \
    && ok "default_model herda do agente: $INHERITED_MODEL" \
    || fail "default_model=$INHERITED_MODEL"

# ─── Test 7: pergunta jurídica → resposta cita LGPD via RAG ───────
echo ""
echo "═══ Test 7: pergunta jurídica → cita LGPD via RAG ═══"
TMP_STREAM=$(mktemp)
/usr/bin/curl -N -sS -X POST "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"content":"Quais são as bases legais para tratamento de dados pessoais segundo a LGPD? Cite o artigo específico.","model":"claude-haiku-4-5"}' \
    "$API/v1/chat/conversations/$CONV/messages" --max-time 60 > "$TMP_STREAM" 2>&1

# Concatenar todos os deltas para verificação
ASST_TEXT=$(grep '"type":"delta"' "$TMP_STREAM" | sed -E 's/.*"content":"([^"]*)".*/\1/' | tr -d '\n')
echo "  →  resposta (preview): $(echo "$ASST_TEXT" | head -c 200)..."

echo "$ASST_TEXT" | grep -qiE "art\.?\s*7|artigo 7" \
    && ok "resposta cita Art. 7º LGPD" \
    || fail "Art. 7 não citado: ${ASST_TEXT:0:300}"

echo "$ASST_TEXT" | grep -qiE "LGPD|13\.709" \
    && ok "resposta cita LGPD/13.709" \
    || fail "LGPD/13.709 não citado"

rm -f "$TMP_STREAM"

# ─── Test 8: retrieval_log com entry recente ───────────────────────
echo ""
echo "═══ Test 8: retrieval_log entry ═══"
N=$(psql_q "SELECT COUNT(*) FROM retrieval_log WHERE created_at > NOW() - INTERVAL '5 minutes'")
[ "$N" -ge 1 ] && ok "$N retrieval logs recentes" || fail "RAG não disparou (logs=0)"

# ─── Test 9: UI rotas ──────────────────────────────────────────────
echo ""
echo "═══ Test 9: UI rotas ═══"
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI/chat?assistant_id=$ASSIST_JURI")
[ "$HTTP" = "200" ] && ok "/chat?assistant_id=X → 200" || fail "$HTTP"
HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "$UI/chat/$CONV")
[ "$HTTP" = "200" ] && ok "/chat/<conv> → 200" || fail "$HTTP"

# Cleanup do teste
/usr/bin/curl -sS -X DELETE "${AUTH[@]}" "$API/v1/chat/conversations/$CONV" > /dev/null

# ─── Test 10: regressão ────────────────────────────────────────────
echo ""
echo "═══ Test 10: regressão (6c.A + 6a₂.C transitivo) ═══"
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
[ "$FAIL" -eq 0 ] && echo "  ✅ Vertical agents PASSED — 6c.A.1 end-to-end" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
