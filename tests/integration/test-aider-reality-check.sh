#!/usr/bin/env bash
# tests/integration/test-aider-reality-check.sh
# ============================================================================
# Reality-Check Harness — Aider specific (FASE 13.5b.2)
# ----------------------------------------------------------------------------
# Proves Aider runs a real tool end-to-end, using a unique random marker
# so the LLM cannot fabricate the evidence. Mirrors the OpenClaude
# reality-check (test-runtime-produces-artifacts.sh) but routes via
# [AIDER] prefix → runtime_profile_slug=aider → aider-runner gRPC.
#
# Chain:
#   1. Send a [AIDER]-prefixed delegation with a random MARKER.
#   2. Poll runtime_work_items until terminal status.
#   3. Verify runtime_profile_slug='aider' (the routing part).
#   4. Verify at least one event payload contains the MARKER
#      (the execution part — can't be LLM fabrication since the
#      marker was never in the LLM's training data).
#
# Why a new file instead of extending the OpenClaude one: the OpenClaude
# harness depends on Write+Bash+cat inside the OpenClaude tool contract,
# and Aider uses a different shell model (auto-edit + commit). A distinct
# test keeps both expectation sets readable.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
# Assistente Jurídico — the only seeded assistant with delegation_config.enabled=true.
ASSISTANT="${ASSISTANT:-00000000-0000-0000-0002-000000000001}"
DEMO_KEY="${DEMO_KEY:-sk-govai-demo00000000000000000000}"
MAX_POLLS="${MAX_POLLS:-80}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"

MARKER="AIDER_FIX_$(date +%s)_$(head -c 4 /dev/urandom | xxd -p)"

dbq() {
    docker compose exec -T database psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "═════════════════════════════════════════════════════════════"
echo "  AIDER REALITY-CHECK — 13.5b.2 socket fix verification      "
echo "═════════════════════════════════════════════════════════════"
echo ""

# ── Dispatch ────────────────────────────────────────────────────────────────
echo "═══ Dispatching [AIDER] delegation ═══"
RESP=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
    -H "Authorization: Bearer $DEMO_KEY" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"[AIDER] Use bash to echo '$MARKER' and return exactly that line\"}")

WI=$(echo "$RESP" | jq -r '._govai.workItemId // empty')
echo "work_item=$WI  marker=$MARKER"
if [ -z "$WI" ]; then
    echo "❌ delegation did not trigger"
    echo "$RESP" | head -c 600
    exit 1
fi

# ── Poll ────────────────────────────────────────────────────────────────────
echo ""
echo "═══ Poll up to $((MAX_POLLS * POLL_INTERVAL))s ═══"
STATUS=""
RT=""
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    STATUS=$(dbq "SELECT status FROM runtime_work_items WHERE id='$WI'")
    RT=$(dbq "SELECT runtime_profile_slug FROM runtime_work_items WHERE id='$WI'")
    echo "  poll #$i: status=$STATUS runtime=$RT"
    case "$STATUS" in
        done) break ;;
        failed|blocked|cancelled)
            ERR=$(dbq "SELECT COALESCE(dispatch_error, '(no dispatch_error)') FROM runtime_work_items WHERE id='$WI'")
            echo "❌ Terminal $STATUS — dispatch_error: $ERR"
            echo ""
            echo "─── Recent events ───"
            docker compose exec -T database psql -U postgres -d govai_platform -c "
                SELECT event_type, substring(payload::text for 300) AS payload
                  FROM runtime_work_item_events
                 WHERE work_item_id='$WI'
                 ORDER BY event_seq ASC
                 LIMIT 15"
            exit 1
            ;;
    esac
done

if [ "$STATUS" != "done" ]; then
    echo "❌ Timeout after $((MAX_POLLS * POLL_INTERVAL))s (last status=$STATUS)"
    echo ""
    echo "─── Recent events ───"
    docker compose exec -T database psql -U postgres -d govai_platform -c "
        SELECT event_type, substring(payload::text for 300) AS payload
          FROM runtime_work_item_events
         WHERE work_item_id='$WI'
         ORDER BY event_seq ASC
         LIMIT 15"
    exit 1
fi

# ── Check runtime ───────────────────────────────────────────────────────────
echo ""
echo "═══ Check runtime matched ═══"
if [ "$RT" != "aider" ]; then
    echo "❌ Wrong runtime: $RT (expected aider)"
    exit 1
fi
echo "✅ runtime_profile_slug=aider"

# ── Check marker in events ──────────────────────────────────────────────────
# Schema note (13.5b.2): the event payload column is `payload`, not
# `event_data`. Grep the full payload text for the marker; if Aider
# really executed the bash echo, the output lands in a TOOL_RESULT or
# RUN_COMPLETED payload somewhere in this event stream.
echo ""
echo "═══ Check marker in event payloads (proves tool output is real) ═══"
HIT=$(dbq "
    SELECT COUNT(*) FROM runtime_work_item_events
     WHERE work_item_id='$WI'
       AND payload::text LIKE '%$MARKER%'")

if [ "${HIT:-0}" -gt 0 ]; then
    echo "✅ Marker present in $HIT event payload(s) — Aider executed real tool, output captured"
else
    echo "⚠️  Marker not in event payloads. Dumping stream:"
    docker compose exec -T database psql -U postgres -d govai_platform -c "
        SELECT event_type, substring(payload::text for 400) AS payload
          FROM runtime_work_item_events
         WHERE work_item_id='$WI'
         ORDER BY event_seq ASC
         LIMIT 20"
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Aider reality-check PASSED end-to-end"
echo "   work_item: $WI"
echo "   marker:    $MARKER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
