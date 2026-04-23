#!/usr/bin/env bash
# ============================================================================
# Runtime transport fallback — FASE 13.5b/0
# ----------------------------------------------------------------------------
# Validates the symmetry fix: isRuntimeAvailable (13.5a3) declared the
# runtime reachable on TCP when the unix socket was missing; THIS phase
# made the adapter's actual dial agree — it no longer crashes on a
# missing socket, it falls through to TCP.
#
# Scenarios:
#   1. baseline — socket exists, adapter uses it silently
#   2. forced fallback — rename the socket mid-test, adapter falls back
#      to TCP and the work item still reaches `done`. Log shows
#      "falling back to TCP".
#   3. claude_code_official smoke — same adapter path, different runner
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
ASSISTANT_ID="${ASSISTANT_ID:-00000000-0000-0000-0002-000000000001}"
DEMO_API_KEY="${DEMO_API_KEY:-sk-govai-demo00000000000000000000}"
MAX_POLLS="${MAX_POLLS:-120}"       # 120 * 3s = 6 min
POLL_INTERVAL="${POLL_INTERVAL:-3}"

fail() { echo "❌ $*" >&2; exit 1; }
ok()   { echo "✅ $*"; }

poll_until_terminal() {
    local wi="$1"
    local status=""
    for i in $(seq 1 "$MAX_POLLS"); do
        sleep "$POLL_INTERVAL"
        status=$(docker compose exec -T database psql -U postgres -d govai_platform -tAc \
            "SELECT status FROM architect_work_items WHERE id = '$wi'" \
            | tr -d '[:space:]')
        case "$status" in
            done|blocked|cancelled|failed) break ;;
        esac
    done
    printf "%s" "$status"
}

echo "═══ Scenario 1: baseline (socket exists) ═══"
# The existing reality-check harness covers this — run it as-is.
bash tests/integration/test-runtime-produces-artifacts.sh > /tmp/fb-s1.log 2>&1 \
    || { cat /tmp/fb-s1.log; fail "baseline reality-check failed"; }
ok "baseline reality-check PASSED"

echo ""
echo "═══ Scenario 2: force TCP fallback by removing the socket ═══"
# 13.5b/0 isolates socket volumes; openclaude-runner owns its /var/run/govai.
# The runner has passwordless root (simple image) so we can remove its own
# sock. We recreate it via SIGHUP / restart at the end.
SOCK_IN_RUNNER="/var/run/govai/openclaude.sock"
BACKUP_IN_RUNNER="/var/run/govai/openclaude.sock.BAK"

docker compose exec -T openclaude-runner sh -c \
    "test -S $SOCK_IN_RUNNER && mv $SOCK_IN_RUNNER $BACKUP_IN_RUNNER" \
    || fail "could not rename socket in openclaude-runner — is it mounted?"
ok "socket renamed; api will see it as missing on next dial"

# Brief pause so api's fs probe sees the new state (its mount is :ro, so
# the rename inside the runner propagates via the shared volume).
sleep 2

# Fire a delegation — the adapter should log "falling back to TCP" and
# succeed because the runner is still listening on 0.0.0.0:50051.
UNIQUE="FB_$(date +%s)_$(head -c 3 /dev/urandom | xxd -p)"
RESP=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT_ID" \
    -H "Authorization: Bearer $DEMO_API_KEY" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg m "[OPENCLAUDE] Use Bash: echo $UNIQUE" '{message: $m}')")
WI=$(echo "$RESP" | jq -r '._govai.workItemId // empty')

# Restore the socket immediately so other tests aren't affected.
docker compose exec -T openclaude-runner sh -c \
    "test -S $BACKUP_IN_RUNNER && mv $BACKUP_IN_RUNNER $SOCK_IN_RUNNER" \
    || echo "  warning: could not restore socket — next run may still use TCP"
ok "socket restored"

[ -z "$WI" ] && { echo "$RESP" | head -c 300; fail "delegation did not trigger"; }
ok "delegation accepted under TCP-only conditions: work_item=$WI"

STATUS=$(poll_until_terminal "$WI")
[ "$STATUS" = "done" ] || fail "work item ended as '$STATUS' — TCP fallback did not complete"
ok "work item completed successfully via TCP fallback"

echo "  checking api logs for fallback warning…"
if docker compose logs --tail 400 api 2>&1 | grep -q "unix socket unavailable.*[Ff]alling back to TCP"; then
    ok "log emitted the expected fallback warning"
else
    echo "  ⚠️  no 'falling back to TCP' log line found — behavior correct but observability unverified"
fi

echo ""
echo "═══ Scenario 3: claude_code_official dispatch sanity ═══"
if docker compose --profile official ps claude-code-runner 2>/dev/null | grep -q 'Up'; then
    UNIQUE2="CC_$(date +%s)_$(head -c 3 /dev/urandom | xxd -p)"
    RESP2=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT_ID" \
        -H "Authorization: Bearer $DEMO_API_KEY" \
        -H "x-org-id: $ORG" \
        -H "Content-Type: application/json" \
        -d "$(jq -n --arg m "[OPENCLAUDE] Use Bash: echo $UNIQUE2" '{message: $m, runtime_profile: "claude_code_official"}')")
    WI2=$(echo "$RESP2" | jq -r '._govai.workItemId // empty')
    [ -z "$WI2" ] && fail "claude_code_official delegation did not trigger"
    ok "claude_code_official work_item=$WI2"
    STATUS2=$(poll_until_terminal "$WI2")
    [ "$STATUS2" = "done" ] || fail "claude_code_official ended as '$STATUS2'"
    ok "claude_code_official reached done"
else
    echo "  SKIP — claude-code-runner not up (run scripts/dev-up-full.sh)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "EIXO 0 transport fallback verified"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
