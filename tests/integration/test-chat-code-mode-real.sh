#!/usr/bin/env bash
# tests/integration/test-chat-code-mode-real.sh
# ============================================================================
# Reality-check — FASE 14.0/6c.B.1 (Modo Code "Claude Desktop quality")
# ----------------------------------------------------------------------------
# Valida os 3 fixes da 6c.B.1:
#
#   FIX 1: Modo Code SEMPRE força runtime=claude_code_official, ignorando o
#          runtime configurado no agente (resolve bug crítico onde Compliance
#          LGPD em Code despachava para OpenClaude e travava em ação negada)
#
#   FIX 2: Stream nativo MESSAGE_DELTA emitido pelo Claude Code SDK e
#          forwarded ao client via /chat polling. UX Claude Desktop:
#          texto fluindo entre tool_use blocks
#
#   FIX 3: Outputs gerados no workspace shared aparecem em /files endpoint
#          após RUN_COMPLETED, prontos p/ download como chips clicáveis
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

# Cleanup rate-limit (pode acumular em CI por testes encadeados)
PASS_REDIS=$(grep -E "^REDIS_PASSWORD=" .env | cut -d= -f2 | tr -d '"' | tr -d "'")
clear_rl() {
    docker compose exec -T redis redis-cli -a "$PASS_REDIS" --no-auth-warning EVAL \
        "for _,k in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', k) end return 1" \
        0 "*login*" >/dev/null 2>&1
}
clear_rl

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Modo Code Real — 14.0/6c.B.1                                  "
echo "════════════════════════════════════════════════════════════════"

echo ""
echo "═══ Setup: admin login ═══"
TOKEN=$(/usr/bin/curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "  ❌ login failed"; exit 1; }
ok "token captured"
AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── Setup: Compliance LGPD agent ───────────────────────────────────
echo ""
echo "═══ Setup: agente Compliance LGPD GovAI ═══"
COMPLIANCE_ID=$(psql_q "SELECT id FROM assistants WHERE name='Compliance LGPD GovAI'")
[ -n "$COMPLIANCE_ID" ] && ok "Compliance ID $COMPLIANCE_ID" \
    || { fail "Compliance agent missing"; exit 1; }

ORIG_RUNTIME=$(psql_q "SELECT runtime_profile_slug FROM assistants WHERE id='$COMPLIANCE_ID'")
ok "agent runtime no DB: $ORIG_RUNTIME (será ignorado em Code)"
[ "$ORIG_RUNTIME" = "openclaude" ] \
    && ok "(fixture esperado openclaude — confirma teste do override)" \
    || echo "  ⚠️  fixture mudou: $ORIG_RUNTIME (não é openclaude — ainda assim Fix 1 deve forçar claude_code_official)"

# ─── Test FIX 1: Runtime hardcode em Modo Code ─────────────────────
echo ""
echo "═══ FIX 1: Runtime hardcode em Modo Code ═══"
CONV=$(/usr/bin/curl -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d "{\"title\":\"Reality 6cB1\",\"assistant_id\":\"$COMPLIANCE_ID\"}" \
    "$API/v1/chat/conversations" | jq -r .id)
ok "conversa criada com agente Compliance LGPD: $CONV"

TMP=$(mktemp)
/usr/bin/curl -N -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"content":"Use bash para criar checklist-realty.md no diretorio atual com 3 itens curtos sobre LGPD. Use apenas caminho relativo (sem barra inicial).","mode":"code"}' \
    "$API/v1/chat/conversations/$CONV/messages" \
    --max-time 180 > "$TMP" 2>&1

WI=$(grep -oE '"work_item_id":"[a-f0-9-]+"' "$TMP" | head -1 | cut -d'"' -f4)
[ -n "$WI" ] && ok "work_item_id capturado: $WI" || { fail "no WI"; cat "$TMP"; exit 1; }

ACTUAL_RUNTIME=$(psql_q "SELECT runtime_profile_slug FROM runtime_work_items WHERE id='$WI'")
[ "$ACTUAL_RUNTIME" = "claude_code_official" ] \
    && ok "WI runtime=$ACTUAL_RUNTIME (Fix 1: ignorou $ORIG_RUNTIME do agente)" \
    || fail "WI runtime=$ACTUAL_RUNTIME (esperado claude_code_official)"

ADAPTER=$(psql_q "SELECT execution_context->>'adapter' FROM runtime_work_items WHERE id='$WI'")
[ "$ADAPTER" = "claude_code" ] \
    && ok "execution_context.adapter=$ADAPTER (consistente com runtime)" \
    || fail "adapter=$ADAPTER (esperado claude_code, divergência detectada)"

FORCED=$(psql_q "SELECT execution_context->>'forced_runtime' FROM runtime_work_items WHERE id='$WI'")
[ "$FORCED" = "true" ] \
    && ok "execution_context.forced_runtime=true (audit trail)" \
    || fail "forced_runtime ausente"

CTX_ORIG=$(psql_q "SELECT execution_context->>'agent_original_runtime' FROM runtime_work_items WHERE id='$WI'")
[ "$CTX_ORIG" = "$ORIG_RUNTIME" ] \
    && ok "execution_context.agent_original_runtime=$CTX_ORIG (audit preservou orig)" \
    || fail "agent_original_runtime divergente: $CTX_ORIG"

WI_STATUS=$(psql_q "SELECT status FROM runtime_work_items WHERE id='$WI'")
[ "$WI_STATUS" = "done" ] \
    && ok "WI status=done (não bloqueou em ação negada do OpenClaude)" \
    || fail "WI status=$WI_STATUS (esperado done)"

RESOLVED_MODEL=$(psql_q "SELECT execution_context->>'resolved_model' FROM runtime_work_items WHERE id='$WI'")
[ -n "$RESOLVED_MODEL" ] && [[ "$RESOLVED_MODEL" == claude-* ]] \
    && ok "resolved_model=$RESOLVED_MODEL (Anthropic-only)" \
    || fail "resolved_model não-Anthropic ou ausente: $RESOLVED_MODEL"

# ─── Test FIX 2: MESSAGE_DELTA stream nativo ───────────────────────
echo ""
echo "═══ FIX 2: MESSAGE_DELTA stream ═══"
N_DELTA=$(grep -oE '"type":"MESSAGE_DELTA"' "$TMP" | wc -l | tr -d ' ')
[ "$N_DELTA" -ge 1 ] \
    && ok "$N_DELTA evento(s) MESSAGE_DELTA no stream (UX Claude Desktop)" \
    || fail "zero MESSAGE_DELTA — bridge.js/runtime-delegation não está streamando texto"

N_TOOL=$(grep -oE '"type":"TOOL_START"' "$TMP" | wc -l | tr -d ' ')
[ "$N_TOOL" -ge 1 ] && ok "$N_TOOL TOOL_START (timeline preservada)" \
    || fail "timeline sem ferramentas (regressão CP1?)"

N_RUN_COMPLETED=$(grep -oE '"type":"RUN_COMPLETED"' "$TMP" | wc -l | tr -d ' ')
[ "$N_RUN_COMPLETED" = "1" ] && ok "RUN_COMPLETED forwarded" \
    || fail "RUN_COMPLETED ausente/duplicado"

# ─── Test FIX 3: Outputs no workspace + /files endpoint ────────────
echo ""
echo "═══ FIX 3: Outputs inline ═══"
WS=/tmp/govai-workspaces/$ORG/$WI
WORKSPACE_FILES=$(docker exec govaigrcplatform-api-1 sh -c "ls $WS 2>/dev/null | wc -l" | tr -d ' ')
[ "$WORKSPACE_FILES" -ge 1 ] \
    && ok "$WORKSPACE_FILES arquivo(s) no workspace shared $WS" \
    || fail "workspace vazio em $WS — Claude Code não usou cwd correto"

FILES_JSON=$(/usr/bin/curl -sS "${AUTH[@]}" "$API/v1/admin/runtime/work-items/$WI/files")
N_FILES=$(echo "$FILES_JSON" | jq '.files | length')
[ "$N_FILES" -ge 1 ] \
    && ok "$N_FILES arquivo(s) em /files endpoint (captureOutputs OK)" \
    || fail "/files vazio — captureOutputs falhou"

FIRST_FID=$(echo "$FILES_JSON" | jq -r '.files[0].id')
FIRST_NAME=$(echo "$FILES_JSON" | jq -r '.files[0].filename')
ok "primeiro arquivo: $FIRST_NAME (id=$FIRST_FID)"

HTTP=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items/$WI/files/$FIRST_FID")
[ "$HTTP" = "200" ] && ok "download HTTP 200" || fail "download falhou ($HTTP)"

# Confirmar que Content-Disposition vem populado p/ filename
CD=$(/usr/bin/curl -sS -o /dev/null -D - "${AUTH[@]}" \
    "$API/v1/admin/runtime/work-items/$WI/files/$FIRST_FID" 2>&1 | \
    grep -i "^content-disposition" | head -1)
[ -n "$CD" ] && ok "Content-Disposition presente: ${CD:0:80}..." \
    || fail "Content-Disposition ausente — UI não conseguirá nomear o download"

# ─── Test: Regressão Modo Chat (sem mode, default) ──────────────────
echo ""
echo "═══ Regressão zero em Modo Chat ═══"
clear_rl

CONV2=$(/usr/bin/curl -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"title":"Regressao chat"}' "$API/v1/chat/conversations" | jq -r .id)

TMP2=$(mktemp)
/usr/bin/curl -N -sS "${AUTH[@]}" -X POST -H "Content-Type: application/json" \
    -d '{"content":"diga apenas: oi","model":"claude-haiku-4-5"}' \
    "$API/v1/chat/conversations/$CONV2/messages" --max-time 30 > "$TMP2" 2>&1

grep -q '"type":"delta"' "$TMP2" \
    && ok "mode chat default emite delta (LiteLLM passthrough preservado)" \
    || fail "mode chat regrediu — sem delta"

! grep -q '"type":"mode_code_started"' "$TMP2" \
    && ok "mode chat NÃO emitiu mode_code_started (regressão zero)" \
    || fail "chat virou code (bug crítico)"

CHAT_MODE=$(psql_q "SELECT mode FROM chat_messages
                       WHERE conversation_id='$CONV2' AND role='assistant'")
[ "$CHAT_MODE" = "chat" ] \
    && ok "mode persistido como chat (default sem override)" \
    || fail "mode persistido = $CHAT_MODE"

# Cleanup
/usr/bin/curl -sS "${AUTH[@]}" -X DELETE "$API/v1/chat/conversations/$CONV"  > /dev/null
/usr/bin/curl -sS "${AUTH[@]}" -X DELETE "$API/v1/chat/conversations/$CONV2" > /dev/null
rm -f "$TMP" "$TMP2"

# ─── Regressão suítes anteriores ────────────────────────────────────
echo ""
echo "═══ Regressão suítes anteriores ═══"
for s in test-chat-mode test-chat-code-mode test-vertical-agents; do
    clear_rl
    if bash "tests/integration/${s}.sh" > "/tmp/r-$s.log" 2>&1; then
        ok "$s pass"
    else
        fail "$s regrediu"
        tail -5 "/tmp/r-$s.log"
    fi
    sleep 5
done

# ─── Summary ────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $((PASS+FAIL)) pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ 6c.B.1 PASSED — 3 fixes validados + regressão zero" \
                  || { echo "  ❌ FAIL"; exit 1; }
echo "════════════════════════════════════════════════════════════════"
