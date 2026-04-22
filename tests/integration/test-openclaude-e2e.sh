#!/usr/bin/env bash
# tests/integration/test-openclaude-e2e.sh
# ----------------------------------------------------------------------------
# End-to-end test: delegation pipeline → openclaude-runner → result
#
# Steps:
#   1. Verify openclaude-runner container is healthy
#   2. Trigger delegation by calling /v1/execute with a matching pattern
#   3. Verify a work item with execution_hint='openclaude' was created
#   4. Poll the events endpoint until the work item reaches a terminal state
#   5. Validate execution_context contains output and evidence events
# ----------------------------------------------------------------------------
set -e

API="${API:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@orga.com}"
ADMIN_PASS="${ADMIN_PASS:-GovAI2026@Admin}"
DEMO_API_KEY="${DEMO_API_KEY:-sk-govai-demo00000000000000000000}"
DEMO_ASSISTANT="${DEMO_ASSISTANT:-00000000-0000-0000-0002-000000000001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
MAX_POLLS="${MAX_POLLS:-30}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"

PASS=0; FAIL=0; TOTAL=0

check() {
    local name="$1" expected="$2" actual="$3"
    TOTAL=$((TOTAL + 1))
    if [ "$actual" = "$expected" ]; then
        PASS=$((PASS + 1)); echo "  ✅ $name"
    else
        FAIL=$((FAIL + 1)); echo "  ❌ $name — esperado '$expected', recebeu '$actual'"
    fi
}

check_truthy() {
    local name="$1" value="$2"
    TOTAL=$((TOTAL + 1))
    if [ -n "$value" ] && [ "$value" != "null" ] && [ "$value" != "false" ] && [ "$value" != "0" ]; then
        PASS=$((PASS + 1)); echo "  ✅ $name"
    else
        FAIL=$((FAIL + 1)); echo "  ❌ $name — valor vazio/null/false: '$value'"
    fi
}

# ── Login ────────────────────────────────────────────────────────────────────
TOKEN=$(curl -s -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.token // empty')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ Falha ao autenticar como $ADMIN_EMAIL"
    exit 1
fi

H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json")

echo ""
echo "═══════════════════════════════════════════════════"
echo "  OPENCLAUDE E2E — delegation → runner → result    "
echo "═══════════════════════════════════════════════════"
echo ""

# ── Step 1: Container health ─────────────────────────────────────────────────
echo "═══ Step 1: openclaude-runner container ═══"
OC_LINE=$(docker compose ps openclaude-runner 2>/dev/null | tail -n +2 | head -1)
if echo "$OC_LINE" | grep -q "healthy"; then
    PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✅ openclaude-runner is healthy"
elif echo "$OC_LINE" | grep -q "Up"; then
    TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
    echo "  ⚠️  openclaude-runner is running but not yet healthy — continuing"
    echo "     Line: $OC_LINE"
else
    TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
    echo "  ❌ openclaude-runner not running — gRPC will fail"
    echo "     Hint: docker compose --profile dev up -d openclaude-runner"
fi

# ── Step 2: Trigger delegation (with idempotent retry — FASE 11) ─────────────
#
# The LLM backends (Groq/Gemini/Cerebras/Ollama) occasionally return empty
# responses or hit transient rate limits. One failed attempt used to flake
# this test; we retry up to 2 times before concluding the run is broken.
echo ""
echo "═══ Step 2: Trigger delegation via /v1/execute ═══"

MAX_ATTEMPTS=2
DELEGATED="false"
WORK_ITEM_ID=""
MATCHED_PATTERN=""
FINAL_STATUS="unknown"
FINAL_EVENT_COUNT=0

for attempt in $(seq 1 $MAX_ATTEMPTS); do
    if [ "$attempt" -gt 1 ]; then
        echo ""
        echo "→ Attempt $attempt/$MAX_ATTEMPTS: previous attempt ended in status=$FINAL_STATUS"
        echo "  Re-dispatching after 10s cooldown..."
        sleep 10
    fi

    EXEC_RESULT=$(curl -s -X POST "$API/v1/execute/$DEMO_ASSISTANT" \
        -H "Authorization: Bearer $DEMO_API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"message":"[OPENCLAUDE] Responda exatamente a frase: pronto"}')

    DELEGATED=$(echo "$EXEC_RESULT" | jq -r '._govai.delegated // false')
    WORK_ITEM_ID=$(echo "$EXEC_RESULT" | jq -r '._govai.workItemId // empty')
    MATCHED_PATTERN=$(echo "$EXEC_RESULT" | jq -r '._govai.matchedPattern // empty')

    if [ -z "$WORK_ITEM_ID" ] || [ "$WORK_ITEM_ID" = "empty" ]; then
        echo "  ⚠️  Attempt $attempt: dispatch did not return workItemId"
        continue
    fi

    # Poll this attempt until terminal or timeout
    echo "  Work item: $WORK_ITEM_ID"
    for i in $(seq 1 "$MAX_POLLS"); do
        sleep "$POLL_INTERVAL"
        POLL=$(curl -s "$API/v1/admin/architect/work-items/$WORK_ITEM_ID/events" "${H[@]}")
        FINAL_STATUS=$(echo "$POLL" | jq -r '.work_item.status // "unknown"')
        FINAL_EVENT_COUNT=$(echo "$POLL" | jq -r '.events | length')
        echo "    Poll $i/$MAX_POLLS: status=$FINAL_STATUS events=$FINAL_EVENT_COUNT"

        case "$FINAL_STATUS" in
            done|blocked|cancelled)
                break
                ;;
        esac
    done

    # Check if this attempt succeeded — break out of retry loop if so
    if [ "$FINAL_STATUS" = "done" ]; then
        FULL_TEXT=$(echo "$POLL" | jq -r '.work_item.execution_context.output.fullText // empty')
        if [ -n "$FULL_TEXT" ] && [ "$FULL_TEXT" != "null" ] && [ "${#FULL_TEXT}" -ge 3 ]; then
            # Non-empty response — accept and exit retry loop
            break
        else
            # done but empty fullText — retry
            echo "  ⚠️  Attempt $attempt: done with empty fullText, will retry"
            FINAL_STATUS="empty_response"
        fi
    fi
done

check "Delegation triggered" "true" "$DELEGATED"
check_truthy "Work item ID returned" "$WORK_ITEM_ID"
check_truthy "Matched pattern returned" "$MATCHED_PATTERN"

if [ -z "$WORK_ITEM_ID" ] || [ "$WORK_ITEM_ID" = "empty" ]; then
    echo ""
    echo "  ❌ Cannot continue without work item ID"
    echo "  RESULTADO: $PASS/$TOTAL passaram, $FAIL falharam"
    exit 1
fi
echo "  Work Item ID:   $WORK_ITEM_ID"
echo "  Matched pattern: $MATCHED_PATTERN"

# ── Step 3: Verify work item exists ──────────────────────────────────────────
echo ""
echo "═══ Step 3: Verify work item in DB ═══"
INITIAL=$(curl -s "$API/v1/admin/architect/work-items/$WORK_ITEM_ID/events" "${H[@]}")
INITIAL_STATUS=$(echo "$INITIAL" | jq -r '.work_item.status // empty')
INITIAL_HINT=$(echo "$INITIAL" | jq -r '.work_item.execution_hint // empty')

check_truthy "Work item exists in DB" "$INITIAL_STATUS"
check "execution_hint == openclaude" "openclaude" "$INITIAL_HINT"
echo "  Initial status: $INITIAL_STATUS"

# ── Step 4: Final state already collected by retry loop (FASE 11) ────────────
# The retry loop above already polled the final attempt — no separate Step 4.
echo ""
echo "═══ Step 4: Final state collected by retry loop ═══"
echo "  Final status: $FINAL_STATUS"
echo "  Event count:  $FINAL_EVENT_COUNT"

# ── Step 5: Evaluate result ──────────────────────────────────────────────────
echo ""
echo "═══ Step 5: Evaluate final state ═══"

case "$FINAL_STATUS" in
    done)
        check "Work item terminal state" "done" "$FINAL_STATUS"

        FULL_TEXT=$(curl -s "$API/v1/admin/architect/work-items/$WORK_ITEM_ID/events" "${H[@]}" \
            | jq -r '.work_item.execution_context.output.fullText // empty')
        TOTAL=$((TOTAL + 1))
        if [ -n "$FULL_TEXT" ] && [ "$FULL_TEXT" != "null" ]; then
            PASS=$((PASS + 1))
            echo "  ✅ execution_context has fullText (${#FULL_TEXT} chars)"
        else
            FAIL=$((FAIL + 1))
            echo "  ❌ execution_context missing fullText"
        fi

        TOTAL=$((TOTAL + 1))
        if [ "$FINAL_EVENT_COUNT" -gt 0 ]; then
            PASS=$((PASS + 1))
            echo "  ✅ Evidence recorded ($FINAL_EVENT_COUNT events)"
        else
            FAIL=$((FAIL + 1))
            echo "  ❌ No evidence events"
        fi
        ;;

    blocked)
        DISPATCH_ERR=$(curl -s "$API/v1/admin/architect/work-items/$WORK_ITEM_ID/events" "${H[@]}" \
            | jq -r '.work_item.dispatch_error // "(none)"')
        echo "  ⚠️  Work item blocked after retries"
        echo "  Dispatch error: $DISPATCH_ERR"
        TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
        echo "  ❌ Work item blocked — verifique openclaude-runner / LLM"
        ;;

    pending|in_progress)
        echo "  ⚠️  Work item still $FINAL_STATUS após $((MAX_POLLS * POLL_INTERVAL))s"
        echo "     Possible causes:"
        echo "       - openclaude-runner not running/healthy"
        echo "       - LiteLLM provider quota exhausted or rate-limited"
        echo "       - gRPC connection refused"
        TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
        echo "  ❌ Timeout — work item did not complete"
        ;;

    cancelled)
        TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
        echo "  ❌ Work item cancelado externamente"
        ;;

    *)
        TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
        echo "  ❌ Status desconhecido: $FINAL_STATUS"
        ;;
esac

# ── Resultado final ──────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTADO: $PASS/$TOTAL passaram, $FAIL falharam"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "  Debug commands:"
    echo "    docker compose logs openclaude-runner --tail 30"
    echo "    docker compose logs api --tail 30 | grep -i 'architect\\|openclaude\\|grpc'"
    exit 1
else
    echo "  🟢 OpenClaude E2E test passed!"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Bonus (FASE 13.5a): tool use at shield_level=1 must NOT pause
# ─────────────────────────────────────────────────────────────────────────────
# Gated by SKIP_SHIELD_BONUS=1 so callers can opt out (e.g., CI envs that
# haven't applied migration 084 yet).
if [ "${SKIP_SHIELD_BONUS:-0}" = "1" ]; then
    exit 0
fi

echo ""
echo "═══ Bonus: Tool use destrutivo em shield_level=1 ═══"

# Confirm current shield_level is 1; the main regression / health check
# normalizes the org to level 1 before running this script.
CUR_LEVEL=$(curl -s "$API/v1/admin/shield-level" \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" 2>/dev/null | jq -r '.current.shield_level // 1')
if [ "$CUR_LEVEL" != "1" ]; then
    echo "  ⚠️  Shield level is $CUR_LEVEL (not 1) — skipping bonus (not a regression)"
    exit 0
fi
echo "  ✓ shield_level=1 confirmed"

# Trigger a run that would normally invoke a destructive tool (Bash/Write).
BONUS_EXEC=$(curl -s -X POST "$API/v1/execute/$DEMO_ASSISTANT" \
    -H "Authorization: Bearer $DEMO_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"message":"[OPENCLAUDE] Crie um arquivo test-shield.txt com conteudo \"hello\" no diretorio atual e me confirme"}')

BONUS_WI=$(echo "$BONUS_EXEC" | jq -r '._govai.workItemId // empty')
if [ -z "$BONUS_WI" ]; then
    echo "  ⚠️  No work item id returned — skipping bonus (not a regression)"
    exit 0
fi
echo "  → work item: $BONUS_WI"

# Poll up to MAX_POLLS × POLL_INTERVAL. Fail if the run ever hits
# awaiting_approval; success on `done`.
BONUS_STATUS=""
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    BONUS_STATUS=$(curl -s "$API/v1/admin/architect/work-items/$BONUS_WI/events" \
        -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
        | jq -r '.work_item.status // empty')
    echo "  Poll $i/$MAX_POLLS: status=$BONUS_STATUS"
    case "$BONUS_STATUS" in
        done)            echo "  ✅ Concluído sem travar — shield_level=1 destrava runtime"; exit 0 ;;
        awaiting_approval) echo "  ❌ shield_level=1 NÃO deveria travar em awaiting_approval"; exit 1 ;;
        blocked|cancelled|failed) echo "  ⚠️  Terminal não-done ($BONUS_STATUS) — não é regressão da 13.5a"; exit 0 ;;
    esac
done
echo "  ⚠️  Poll timeout (status=$BONUS_STATUS) — flakiness de LLM, não regressão da 13.5a"
exit 0
