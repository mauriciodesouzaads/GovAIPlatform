#!/usr/bin/env bash
# tests/integration/test-claude-code-mcp.sh
# ============================================================================
# Reality-check — Claude Code MCP server registry (FASE 14.0/3b · Feature 1)
# ----------------------------------------------------------------------------
# This test validates the *wiring* between admin route → DB → adapter →
# bridge → CLI. It does NOT require an actual MCP subprocess to spawn
# successfully — that would couple the test to npm registry availability
# and to the model deciding to invoke a particular tool. Instead we
# verify:
#
#   1. POST /v1/admin/mcp-servers creates a config (201 + masked secrets).
#   2. GET /v1/admin/mcp-servers lists it back, with `env` masked to '***'.
#   3. PATCH toggles enabled = false; GET still returns the row.
#   4. DELETE removes it; GET returns empty list.
#   5. Dispatch a [CLAUDE_CODE] run with runtime_options.mcp_server_ids
#      set to a real config id. The bridge.js log line
#      `mcp servers mounted: <name>` proves the config flowed through the
#      gRPC stream all the way to the spawn site. The actual MCP server
#      doesn't need to start successfully — we cancel before then.
#
# Heavy "model actually uses an MCP tool" coverage is left for a manual
# smoke test (it requires a live MCP server image which is out of CI
# scope). The pieces THIS test gates are the ones we wrote in 14.0/3b.
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
H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json")

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  MCP servers registry — 14.0/3b · Feature 1 reality-check     "
echo "════════════════════════════════════════════════════════════════"
echo ""

# ── Test 1: CREATE ──────────────────────────────────────────────────────────
echo "═══ Test 1: POST /v1/admin/mcp-servers ═══"
NAME="test-mcp-$(date +%s)"
SECRET="ghp_supersecrettokenwithmorethaneightchars"
CREATE_RESP=$(curl -sS -X POST "$API/v1/admin/mcp-servers" "${H[@]}" \
    -d "{
        \"name\": \"$NAME\",
        \"transport\": \"stdio\",
        \"config\": {
            \"command\": \"echo\",
            \"args\": [\"-n\", \"hello\"],
            \"env\": { \"GITHUB_TOKEN\": \"$SECRET\", \"SHORT\": \"abc\" }
        },
        \"enabled\": true
    }")
MCP_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')

if [ -n "$MCP_ID" ]; then ok "CREATE returned id $MCP_ID"; else
    fail "CREATE response missing id"
    echo "    $(echo "$CREATE_RESP" | head -c 400)"
    exit 1
fi

# Mask check: long secret should be ***, short value should pass through.
RETURNED_TOKEN=$(echo "$CREATE_RESP" | jq -r '.config.env.GITHUB_TOKEN')
RETURNED_SHORT=$(echo "$CREATE_RESP" | jq -r '.config.env.SHORT')
if [ "$RETURNED_TOKEN" = "***" ]; then ok "long env value masked to ***"; else
    fail "GITHUB_TOKEN should be masked, got: $RETURNED_TOKEN"
fi
if [ "$RETURNED_SHORT" = "abc" ]; then ok "short env value left intact"; else
    fail "SHORT should pass through, got: $RETURNED_SHORT"
fi

# ── Test 2: LIST ────────────────────────────────────────────────────────────
echo ""
echo "═══ Test 2: GET /v1/admin/mcp-servers ═══"
LIST_RESP=$(curl -sS "${H[@]}" "$API/v1/admin/mcp-servers")
COUNT=$(echo "$LIST_RESP" | jq "[ .[] | select(.id == \"$MCP_ID\") ] | length")
[ "$COUNT" = "1" ] && ok "LIST contains the new config" || fail "LIST count=$COUNT"

# ── Test 3: PATCH disable ───────────────────────────────────────────────────
echo ""
echo "═══ Test 3: PATCH disable ═══"
PATCH_RESP=$(curl -sS -X PATCH "$API/v1/admin/mcp-servers/$MCP_ID" "${H[@]}" \
    -d '{"enabled": false}')
PATCHED=$(echo "$PATCH_RESP" | jq -r '.enabled')
[ "$PATCHED" = "false" ] && ok "PATCH applied" || fail "PATCH did not flip enabled"

# Re-enable for the dispatch test below
curl -sS -X PATCH "$API/v1/admin/mcp-servers/$MCP_ID" "${H[@]}" -d '{"enabled": true}' >/dev/null

# ── Test 4: DISPATCH a [CLAUDE_CODE] run with mcp_server_ids ────────────────
echo ""
echo "═══ Test 4: dispatch [CLAUDE_CODE] with mcp_server_ids ═══"
PROMPT="[CLAUDE_CODE] List the contents of \$PWD using bash."
RESP=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
    -H "Authorization: Bearer $DEMO_KEY" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -d "{
        \"message\": \"$PROMPT\",
        \"runtime_profile\": \"claude_code_official\",
        \"runtime_options\": { \"mcp_server_ids\": [\"$MCP_ID\"] }
    }")
WI=$(echo "$RESP" \
    | jq -r '.choices[0].message.content // ""' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1)
if [ -n "$WI" ]; then ok "delegation triggered, work_item=$WI"; else
    fail "delegation did not trigger"
    echo "    $(echo "$RESP" | head -c 500)"
    exit 1
fi

# Wait briefly so bridge.js logs the spawn line. We don't poll to `done`
# here because the MCP server `echo` won't speak the MCP protocol —
# the CLI may eventually time out trying to handshake. What we care
# about is the spawn-time log proving config arrived.
sleep 5

# ── Test 5: bridge log shows MCP servers mounted ────────────────────────────
echo ""
echo "═══ Test 5: bridge log proves mcp servers reached the spawn ═══"
if docker compose logs claude-code-runner 2>&1 | grep -q "mcp servers mounted: $NAME"; then
    ok "bridge log: 'mcp servers mounted: $NAME'"
else
    fail "bridge log did NOT mention 'mcp servers mounted: $NAME'"
    echo "    Last 20 runner log lines:"
    docker compose logs claude-code-runner --tail=20 2>&1 | sed 's/^/    /'
fi

# ── Test 6: workspace contains the JSON config bridge.js wrote ──────────────
echo ""
echo "═══ Test 6: .govai-mcp-config.json present in workspace ═══"
# Workspace path for new claude-code sessions = /tmp/govai-workspaces/<orgId>/<workItemId>
WS="/tmp/govai-workspaces/$ORG/$WI"
if docker compose exec -T claude-code-runner test -f "$WS/.govai-mcp-config.json"; then
    ok "config file exists at $WS/.govai-mcp-config.json"
    # Confirm shape
    DUMP=$(docker compose exec -T claude-code-runner cat "$WS/.govai-mcp-config.json")
    if echo "$DUMP" | grep -q "\"$NAME\""; then
        ok "config file contains server name '$NAME'"
    else
        fail "config file missing server name"
        echo "$DUMP" | head -c 400
    fi
else
    fail "config file not found at $WS/.govai-mcp-config.json"
fi

# ── Cleanup ─────────────────────────────────────────────────────────────────
echo ""
echo "═══ Cleanup ═══"
# Note: omit Content-Type on DELETE — Fastify's default parser rejects empty
# JSON bodies (FST_ERR_CTP_EMPTY_JSON_BODY) when the header is set but body
# is empty. DELETE has no body so we send minimal headers.
DELETE_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
    "$API/v1/admin/mcp-servers/$MCP_ID" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG")
[ "$DELETE_CODE" = "204" ] || echo "    DELETE returned HTTP $DELETE_CODE"
LIST_AFTER=$(curl -sS "${H[@]}" "$API/v1/admin/mcp-servers" | jq "[ .[] | select(.id == \"$MCP_ID\") ] | length")
[ "$LIST_AFTER" = "0" ] && ok "DELETE removed the config" || fail "DELETE didn't remove (LIST_AFTER=$LIST_AFTER)"

# Cancel the still-running work_item so it doesn't hold a session forever.
docker compose exec -T database psql -U postgres -d govai_platform \
    -c "UPDATE runtime_work_items SET status='cancelled' WHERE id='$WI' AND status='in_progress'" >/dev/null 2>&1 || true

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ MCP reality-check PASSED" || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
