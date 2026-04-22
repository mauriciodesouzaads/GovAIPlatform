#!/usr/bin/env bash
# ============================================================================
# Concurrent Delegation E2E — FASE 13.5a1
# ----------------------------------------------------------------------------
# Reproduces the original 13.5a UX bug and confirms the hotfix.
#
# Bug (pre-13.5a1): user submits two [OPENCLAUDE] prompts in quick
# succession. The second one fails `acquireTenantSlot` while the first
# still holds the single concurrency slot. BullMQ retries 3×
# (exp backoff 5/10/20s, ~35s total) while the first run takes
# 60-180s to finish. After the 3rd retry, BullMQ drops the job. The
# work_item stays in `status='pending'` forever — "Aguardando dispatch…"
# spinning in the UI with no progress.
#
# Fix A (architect.worker.ts): TENANT_LIMIT rejection no longer throws.
# It re-enqueues the dispatch as a NEW job with a fresh attempts budget
# and a 30s delay, up to TENANT_LIMIT_MAX_REQUEUES times. The second
# work_item now waits for the slot and eventually completes.
#
# This test:
#   1. auths + picks an assistant with delegation_config.enabled=true
#   2. submits work item A
#   3. immediately submits work item B (within 2s)
#   4. polls both via DB (avoids UI) up to 8 minutes
#   5. succeeds ONLY if both hit status='done'
#
# The fix is considered applied iff this test passes.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@orga.com}"
ADMIN_PASS="${ADMIN_PASS:-GovAI2026@Admin}"
DEMO_API_KEY="${DEMO_API_KEY:-sk-govai-demo00000000000000000000}"

MAX_POLLS="${MAX_POLLS:-160}"     # 160 × 3s = 480s = 8 min
POLL_INTERVAL="${POLL_INTERVAL:-3}"

fail() { echo "❌ $*" >&2; exit 1; }
ok()   { echo "✅ $*"; }

echo "═══ Step 1: Authenticate ═══"
TOKEN=$(curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "login failed"
ok "token acquired"

AUTH_H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG")

echo ""
echo "═══ Step 2: Find assistant with delegation_config.enabled ═══"
ASSISTANT=$(curl -sS "$API/v1/admin/assistants/available" "${AUTH_H[@]}" \
    | jq -r '.[] | select(.delegation_enabled == true or .delegation_config.enabled == true) | .id' \
    | head -n1)
if [ -z "$ASSISTANT" ] || [ "$ASSISTANT" = "null" ]; then
    # Fallback — any assistant works; the [OPENCLAUDE] prefix forces the route
    ASSISTANT=$(curl -sS "$API/v1/admin/assistants/available" "${AUTH_H[@]}" \
        | jq -r '.[0].id')
fi
[ -n "$ASSISTANT" ] && [ "$ASSISTANT" != "null" ] || fail "no assistant available"
ok "using assistant $ASSISTANT"

submit() {
    local label="$1"
    local msg="$2"
    local body
    body=$(jq -n --arg m "$msg" '{message: $m}')
    local resp
    resp=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
        -H "Authorization: Bearer $DEMO_API_KEY" \
        -H "Content-Type: application/json" \
        -d "$body")
    local wi
    wi=$(echo "$resp" | jq -r '._govai.workItemId // .workItemId // empty')
    if [ -z "$wi" ]; then
        echo "  response for $label: $(echo "$resp" | jq -c . | head -c 300)"
        fail "no workItemId returned for $label"
    fi
    echo "$wi"
}

echo ""
echo "═══ Step 3: Submit work_item A ═══"
WI_A=$(submit "A" "[OPENCLAUDE] responda apenas: one")
ok "WI_A=$WI_A"

sleep 2

echo ""
echo "═══ Step 4: Submit work_item B (2s after A — will hit TENANT_LIMIT) ═══"
WI_B=$(submit "B" "[OPENCLAUDE] responda apenas: two")
ok "WI_B=$WI_B"

echo ""
echo "═══ Step 5: Poll both work items (max ${MAX_POLLS}×${POLL_INTERVAL}s) ═══"

terminal_states='done|blocked|cancelled|failed'
status_of() {
    curl -sS "$API/v1/admin/architect/work-items/$1/events" "${AUTH_H[@]}" \
        | jq -r '.work_item.status // "?"'
}

STATUS_A="pending"
STATUS_B="pending"
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    STATUS_A=$(status_of "$WI_A")
    STATUS_B=$(status_of "$WI_B")
    echo "  poll $i/$MAX_POLLS:  A=$STATUS_A  B=$STATUS_B"

    A_TERM=0; B_TERM=0
    [[ "$STATUS_A" =~ ^($terminal_states)$ ]] && A_TERM=1
    [[ "$STATUS_B" =~ ^($terminal_states)$ ]] && B_TERM=1

    if [ "$A_TERM" = "1" ] && [ "$B_TERM" = "1" ]; then
        break
    fi
done

echo ""
echo "═══ Step 6: Evaluate ═══"
[ "$STATUS_A" = "done" ] || fail "A ended as '$STATUS_A' (expected done)"
ok "A done"
[ "$STATUS_B" = "done" ] || fail "B ended as '$STATUS_B' (expected done) — TENANT_LIMIT fix incomplete"
ok "B done"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTADO: both work items completed"
echo "═══════════════════════════════════════════════════"
echo "  🟢 Concurrent delegation test passed — Fix A works end-to-end"
