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

# ── Step 2: Trigger delegation ───────────────────────────────────────────────
echo ""
echo "═══ Step 2: Trigger delegation via /v1/execute ═══"
EXEC_RESULT=$(curl -s -X POST "$API/v1/execute/$DEMO_ASSISTANT" \
    -H "Authorization: Bearer $DEMO_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"message":"analise o repositório e identifique problemas de segurança"}')

DELEGATED=$(echo "$EXEC_RESULT" | jq -r '._govai.delegated // false')
WORK_ITEM_ID=$(echo "$EXEC_RESULT" | jq -r '._govai.workItemId // empty')
MATCHED_PATTERN=$(echo "$EXEC_RESULT" | jq -r '._govai.matchedPattern // empty')

check "Delegation triggered" "true" "$DELEGATED"
check_truthy "Work item ID returned" "$WORK_ITEM_ID"
check_truthy "Matched pattern returned" "$MATCHED_PATTERN"

if [ -z "$WORK_ITEM_ID" ] || [ "$WORK_ITEM_ID" = "empty" ]; then
    echo ""
    echo "  ❌ Cannot continue without work item ID"
    echo "  Response: $(echo "$EXEC_RESULT" | jq -c .)"
    echo ""
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

# ── Step 4: Poll until terminal ──────────────────────────────────────────────
echo ""
echo "═══ Step 4: Poll for completion (max $((MAX_POLLS * POLL_INTERVAL))s) ═══"
FINAL_STATUS="unknown"
FINAL_EVENT_COUNT=0
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    POLL=$(curl -s "$API/v1/admin/architect/work-items/$WORK_ITEM_ID/events" "${H[@]}")
    FINAL_STATUS=$(echo "$POLL" | jq -r '.work_item.status // "unknown"')
    FINAL_EVENT_COUNT=$(echo "$POLL" | jq -r '.events | length')
    echo "  Poll $i/$MAX_POLLS: status=$FINAL_STATUS events=$FINAL_EVENT_COUNT"

    case "$FINAL_STATUS" in
        done|blocked|cancelled)
            break
            ;;
    esac
done

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
