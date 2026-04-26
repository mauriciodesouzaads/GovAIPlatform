#!/usr/bin/env bash
# tests/integration/test-runtime-admin-api.sh
# ============================================================================
# Reality-check — Runtime Admin API (FASE 14.0/5a)
# ----------------------------------------------------------------------------
# Validates the 6 endpoints under /v1/admin/runtime/* that Etapa 5b's
# UI consumes:
#
#   GET    /work-items                 — list + filters + cursor
#   GET    /work-items/:id             — detail + events + subagents
#   GET    /work-items/:id/events/stream — SSE live tail
#   POST   /work-items/:id/cancel       — graceful cancel
#   GET    /sessions                   — claude-code session index
#   GET    /runners/health             — per-runtime availability
#
# Plus a regression check that legacy /v1/admin/architect/work-items/:id/events
# still works (playground depends on it until 5b completes the cutover).
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
ASSISTANT="${ASSISTANT:-00000000-0000-0000-0002-000000000001}"
DEMO_KEY="${DEMO_KEY:-sk-govai-demo00000000000000000000}"

dbq() { docker compose exec -T database psql -U postgres -d govai_platform -tAc "$1"; }

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

# ── Login ──
TOKEN=$(curl -s -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "❌ login failed"; exit 1; }
H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG")

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Runtime Admin API — 14.0/5a reality-check                    "
echo "════════════════════════════════════════════════════════════════"

# ── Test 1: list + pagination ──────────────────────────────────────────────
echo ""
echo "═══ Test 1: GET /work-items list + pagination ═══"
LIST=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items?limit=5")
COUNT=$(echo "$LIST" | jq '.items | length')
TOTAL_EST=$(echo "$LIST" | jq -r '.total_estimate')
NEXT=$(echo "$LIST" | jq -r '.next_cursor // empty')
echo "  items=$COUNT  total_estimate=$TOTAL_EST  next_cursor=${NEXT:-<null>}"

if [ "$COUNT" -ge 0 ] && echo "$LIST" | jq -e '.items' >/dev/null; then
    ok "list returned (count=$COUNT)"
else
    fail "list malformed"; echo "    $(echo "$LIST" | head -c 400)"
fi

# Verify required summary fields on each item
INVALID=$(echo "$LIST" | jq '[.items[] |
    select(
        (has("id") and has("status") and has("title") and has("created_at")
         and has("tool_count") and has("event_count") and has("has_error")
         and has("subagent_depth")) | not
    )] | length')
[ "$INVALID" = "0" ] && ok "all items have required summary fields" \
                    || fail "$INVALID items missing required fields"

# Cursor pagination — fetch next page if there is one
if [ -n "$NEXT" ]; then
    PAGE2=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items?limit=5&cursor=$NEXT")
    P2_COUNT=$(echo "$PAGE2" | jq '.items | length')
    OVERLAP=$(jq --slurp '
        .[0].items as $a | .[1].items as $b |
        [$a[].id] as $aids |
        [$b[] | select(.id as $id | $aids | index($id))] | length
    ' <(echo "$LIST") <(echo "$PAGE2"))
    [ "$OVERLAP" = "0" ] && ok "cursor page 2 disjoint from page 1 ($P2_COUNT new)" \
                          || fail "page overlap of $OVERLAP items"
else
    echo "  ⚠️  total <= 5, can't exercise cursor pagination"
fi

# ── Test 2: status filter ──────────────────────────────────────────────────
echo ""
echo "═══ Test 2: status filter ═══"
DONE_LIST=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items?status=done&limit=10")
WRONG_STATUS=$(echo "$DONE_LIST" | jq '[.items[] | select(.status != "done")] | length')
DONE_COUNT=$(echo "$DONE_LIST" | jq '.items | length')
[ "$WRONG_STATUS" = "0" ] && ok "status=done filter clean ($DONE_COUNT items, all done)" \
                          || fail "status filter leaked $WRONG_STATUS non-done items"

MULTI=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items?status=done,pending&limit=10")
MULTI_BAD=$(echo "$MULTI" | jq '[.items[] | select(.status != "done" and .status != "pending")] | length')
[ "$MULTI_BAD" = "0" ] && ok "comma-separated status accepted" \
                       || fail "multi-status filter broken"

# Reject invalid status
BAD=$(curl -sS -o /dev/null -w "%{http_code}" "${H[@]}" \
    "$API/v1/admin/runtime/work-items?status=banana")
[ "$BAD" = "400" ] && ok "invalid status rejected with 400" \
                   || fail "invalid status returned $BAD (expected 400)"

# ── Test 3: runtime_profile_slug filter ────────────────────────────────────
echo ""
echo "═══ Test 3: runtime_profile_slug filter ═══"
RT=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items?runtime_profile_slug=claude_code_official&limit=10")
WRONG=$(echo "$RT" | jq '[.items[] | select(.runtime_profile_slug != "claude_code_official")] | length')
[ "$WRONG" = "0" ] && ok "runtime filter isolates claude_code_official" \
                   || fail "filter leaked $WRONG other runtimes"

# ── Test 4: detail by id ───────────────────────────────────────────────────
echo ""
echo "═══ Test 4: detail by id ═══"
SAMPLE_ID=$(echo "$LIST" | jq -r '.items[0].id // empty')
if [ -n "$SAMPLE_ID" ]; then
    DETAIL=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/work-items/$SAMPLE_ID")
    DETAIL_ID=$(echo "$DETAIL" | jq -r '.work_item.id // empty')
    EVENTS_LEN=$(echo "$DETAIL" | jq '.events | length')
    SUBS_LEN=$(echo "$DETAIL" | jq '.subagents | length')
    if [ "$DETAIL_ID" = "$SAMPLE_ID" ]; then
        ok "detail returned correct work_item ($EVENTS_LEN events, $SUBS_LEN subagents)"
    else
        fail "detail returned wrong id"
    fi

    # Detail-only fields must be present
    HAS_FULL=$(echo "$DETAIL" | jq '.work_item |
        (has("execution_context") and has("dispatch_attempts")
         and has("worker_runtime") and has("recovery_attempts"))')
    [ "$HAS_FULL" = "true" ] && ok "detail carries full-row columns" \
                             || fail "detail missing full-row columns"
else
    echo "  ⚠️  no work_items in DB to fetch detail — skipping"
fi

# Bad uuid → 400
BAD_ID=$(curl -sS -o /dev/null -w "%{http_code}" "${H[@]}" \
    "$API/v1/admin/runtime/work-items/not-a-uuid")
[ "$BAD_ID" = "400" ] && ok "non-uuid id rejected with 400" \
                      || fail "non-uuid returned $BAD_ID"

# Missing → 404
MISSING=$(curl -sS -o /dev/null -w "%{http_code}" "${H[@]}" \
    "$API/v1/admin/runtime/work-items/00000000-0000-0000-0000-000000000999")
[ "$MISSING" = "404" ] && ok "missing id returns 404" \
                       || fail "missing id returned $MISSING"

# ── Test 5: SSE live tail ──────────────────────────────────────────────────
echo ""
echo "═══ Test 5: SSE /work-items/:id/events/stream ═══"
RESP=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
    -H "Authorization: Bearer $DEMO_KEY" \
    "${H[@]}" \
    -H "Content-Type: application/json" \
    -d '{"message":"[OPENCLAUDE] use bash echo SSE_REALITY_CHECK_OK","runtime_profile":"openclaude"}')
NEW_WI=$(echo "$RESP" \
    | jq -r '.choices[0].message.content // ""' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1)
if [ -z "$NEW_WI" ]; then
    fail "delegation didn't fire — can't test SSE"
else
    ok "spawned work_item $NEW_WI for SSE test"

    # Read up to 60s of SSE; capture lines. Use curl --max-time
    # (portable across macOS/Linux) instead of GNU coreutils `timeout`
    # which isn't installed on macOS by default.
    SSE_OUT=$(curl --max-time 60 -sS -N "${H[@]}" \
        "$API/v1/admin/runtime/work-items/$NEW_WI/events/stream" 2>/dev/null \
        || true)

    if echo "$SSE_OUT" | grep -q "^event: RUN_STARTED$"; then
        ok "SSE delivered RUN_STARTED"
    else
        fail "SSE missing RUN_STARTED"
    fi

    # Either we saw stream_end OR at least 2 events landed
    if echo "$SSE_OUT" | grep -q "^event: stream_end$"; then
        ok "SSE closed via stream_end (terminal status reached)"
    else
        EVT_COUNT=$(echo "$SSE_OUT" | grep -c "^event: " || true)
        if [ "$EVT_COUNT" -ge 2 ]; then
            ok "SSE delivered $EVT_COUNT events (no stream_end yet — ok for live work)"
        else
            fail "SSE only delivered $EVT_COUNT events"
        fi
    fi
fi

# ── Test 6: sessions list ──────────────────────────────────────────────────
echo ""
echo "═══ Test 6: GET /sessions ═══"
SESS=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/sessions")
SESS_COUNT=$(echo "$SESS" | jq '.sessions | length')
SESS_ARR=$(echo "$SESS" | jq -e '.sessions' >/dev/null && echo yes || echo no)
[ "$SESS_ARR" = "yes" ] && ok "sessions array returned ($SESS_COUNT entries)" \
                        || fail "sessions response malformed"

# Check shape on at least one entry if present
if [ "$SESS_COUNT" -gt 0 ]; then
    HAS_FIELDS=$(echo "$SESS" | jq '.sessions[0] |
        (has("session_id") and has("last_used_unix_ms")
         and has("runtime_slug") and has("message_count"))')
    [ "$HAS_FIELDS" = "true" ] && ok "session entry has required fields" \
                               || fail "session entry missing fields"
fi

# ── Test 7: runners health ─────────────────────────────────────────────────
echo ""
echo "═══ Test 7: GET /runners/health ═══"
HEALTH=$(curl -sS "${H[@]}" "$API/v1/admin/runtime/runners/health")
H_COUNT=$(echo "$HEALTH" | jq '.runners | length')
H_AVAIL=$(echo "$HEALTH" | jq '[.runners[] | select(.available == true)] | length')
[ "$H_COUNT" = "3" ] && ok "3 runners listed" \
                     || fail "expected 3 runners, got $H_COUNT"
[ "$H_AVAIL" = "3" ] && ok "all 3 runners available" \
                     || echo "  ⚠️  only $H_AVAIL/3 available (env-dependent)"

HAS_TRANSPORT=$(echo "$HEALTH" | jq '[.runners[] | select((.transport=="unix" or .transport=="tcp"))] | length')
[ "$HAS_TRANSPORT" = "$H_COUNT" ] && ok "all runners report transport" \
                                  || fail "transport missing on some runners"

# ── Test 8: cancel ─────────────────────────────────────────────────────────
echo ""
echo "═══ Test 8: cancel ═══"
RESP2=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
    -H "Authorization: Bearer $DEMO_KEY" \
    "${H[@]}" \
    -H "Content-Type: application/json" \
    -d '{"message":"[OPENCLAUDE] use bash sleep 60 && echo done","runtime_profile":"openclaude"}')
WI_TO_CANCEL=$(echo "$RESP2" \
    | jq -r '.choices[0].message.content // ""' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1)
if [ -z "$WI_TO_CANCEL" ]; then
    fail "couldn't spawn target for cancel test"
else
    sleep 2
    # POST with no body — DO NOT send Content-Type: application/json,
    # Fastify rejects that combo with FST_ERR_CTP_EMPTY_JSON_BODY
    # (same gotcha hit in 14.0/3b's MCP DELETE test).
    CANCEL_RESP=$(curl -sS -X POST \
        -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
        "$API/v1/admin/runtime/work-items/$WI_TO_CANCEL/cancel")
    CANCELLED=$(echo "$CANCEL_RESP" | jq -r '.cancelled // empty')
    [ "$CANCELLED" = "true" ] && ok "cancel: 200 cancelled=true" \
                              || fail "cancel didn't return cancelled=true (resp=$CANCEL_RESP)"

    # Cancel of already-done item → 404
    sleep 8
    SECOND=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
        -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
        "$API/v1/admin/runtime/work-items/$WI_TO_CANCEL/cancel")
    [ "$SECOND" = "404" ] && ok "second cancel returns 404 (no longer cancellable)" \
                          || echo "  ⚠️  second cancel returned $SECOND (race: item may not be terminal yet)"
fi

# ── Test 9: legacy /v1/admin/architect/* still works ───────────────────────
echo ""
echo "═══ Test 9: legacy /v1/admin/architect/work-items/:id/events ═══"
if [ -n "$SAMPLE_ID" ]; then
    LEGACY=$(curl -sS "${H[@]}" "$API/v1/admin/architect/work-items/$SAMPLE_ID/events")
    LEG_ID=$(echo "$LEGACY" | jq -r '.work_item.id // empty')
    [ "$LEG_ID" = "$SAMPLE_ID" ] && ok "legacy route still answers correctly" \
                                 || fail "legacy route broken"
else
    echo "  ⚠️  no sample id to test legacy route"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Runtime Admin API reality-check PASSED" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
