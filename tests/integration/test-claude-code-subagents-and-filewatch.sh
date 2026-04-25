#!/usr/bin/env bash
# tests/integration/test-claude-code-subagents-and-filewatch.sh
# ============================================================================
# Reality-check — Claude Code subagents + file watch (FASE 14.0/3b · F2/F3)
# ----------------------------------------------------------------------------
# Two features share one harness because both fire from the same
# CLI invocation:
#
#   Feature 2 (subagents): the model dispatches a Task → bridge.js
#     emits subagent_spawn → adapter inserts a child runtime_work_item
#     with parent_work_item_id set + SUBAGENT_SPAWN event on parent.
#
#   Feature 3 (file watch): chokidar in bridge.js watches the run's
#     cwd → emits file_changed for each fs event → adapter persists
#     as event_type='FILE_CHANGED'.
#
# We dispatch a single [CLAUDE_CODE] run with enable_subagents=true
# and a prompt that asks the model to:
#   (a) write 3 files via Bash → 3 FILE_CHANGED events expected
#   (b) dispatch a Task subagent → 1 SUBAGENT_SPAWN + 1 SUBAGENT_COMPLETE
#       event on the parent + 1 child runtime_work_item row.
#
# Both invariants are model-driven and may flake (the model could
# choose Bash instead of Task, or write fewer files). We track each
# soft (warn-on-zero) vs hard (fail-on-zero) per the user's
# pre-decision on 3a (sessions hard, thinking soft). Here we treat:
#   - FILE_CHANGED count >= 1: HARD (chokidar wiring is deterministic
#     once the model writes anything).
#   - SUBAGENT_SPAWN count >= 1: SOFT (model decision; we ask but it
#     may decline).
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
ASSISTANT="${ASSISTANT:-00000000-0000-0000-0002-000000000001}"
DEMO_KEY="${DEMO_KEY:-sk-govai-demo00000000000000000000}"
MAX_POLLS="${MAX_POLLS:-100}"
POLL_INTERVAL="${POLL_INTERVAL:-3}"

dbq() { docker compose exec -T database psql -U postgres -d govai_platform -tAc "$1"; }

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }
warn() { TOTAL=$((TOTAL+1)); echo "  ⚠️  $1"; }

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Subagents (F2) + File watch (F3) — 14.0/3b reality-check     "
echo "════════════════════════════════════════════════════════════════"
echo ""

MARKER="MULTI_$(date +%s)_$(head -c 4 /dev/urandom | xxd -p)"
PROMPT=$(cat <<EOF
[CLAUDE_CODE] Do these two things in order:
1. Use the Bash tool to create three files in the current working directory: a-${MARKER}.txt, b-${MARKER}.txt, c-${MARKER}.txt. Each file must contain its own filename.
2. Use the Task tool with subagent_type=general-purpose to dispatch a sub-agent that confirms the three files exist and reports back the marker '${MARKER}'.
EOF
)

echo "═══ Dispatch [CLAUDE_CODE] with enable_subagents=true ═══"
RESP=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT" \
    -H "Authorization: Bearer $DEMO_KEY" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$PROMPT" '{ message:$msg, runtime_profile:"claude_code_official", runtime_options:{enable_subagents:true} }')")

WI=$(echo "$RESP" \
    | jq -r '.choices[0].message.content // ""' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1)
if [ -z "$WI" ]; then
    fail "delegation did not trigger"
    echo "    $(echo "$RESP" | head -c 600)"
    exit 1
fi
ok "delegation triggered: $WI  marker=$MARKER"

echo ""
echo "═══ Poll up to $((MAX_POLLS * POLL_INTERVAL))s ═══"
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    STATUS=$(dbq "SELECT status FROM runtime_work_items WHERE id='$WI'")
    case "$STATUS" in
        done)              break ;;
        failed|blocked|cancelled)
            ERR=$(dbq "SELECT COALESCE(dispatch_error,'(no error)') FROM runtime_work_items WHERE id='$WI'")
            fail "terminal $STATUS — $ERR"
            docker compose exec -T database psql -U postgres -d govai_platform -c \
                "SELECT event_type, substring(payload::text for 200) FROM runtime_work_item_events WHERE work_item_id='$WI' ORDER BY event_seq LIMIT 30"
            exit 1
            ;;
    esac
done
[ "$STATUS" = "done" ] || { fail "timeout last_status=$STATUS"; exit 1; }
ok "parent run reached status=done"

# ── F3: FILE_CHANGED events (HARD — chokidar should always catch writes) ────
echo ""
echo "═══ Test 3 (F3): FILE_CHANGED events on parent ═══"
FC=$(dbq "SELECT COUNT(*) FROM runtime_work_item_events
           WHERE work_item_id='$WI' AND event_type='FILE_CHANGED'")
echo "  FILE_CHANGED count = $FC"
if [ "$FC" -ge 1 ]; then
    ok "$FC FILE_CHANGED event(s) captured by chokidar"
else
    fail "no FILE_CHANGED events — file watcher wiring broken"
fi

# Path of one of the marker files should appear in the event payload.
MARKER_HIT=$(dbq "SELECT COUNT(*) FROM runtime_work_item_events
                   WHERE work_item_id='$WI'
                     AND event_type='FILE_CHANGED'
                     AND payload::text LIKE '%${MARKER}%'")
[ "$MARKER_HIT" -ge 1 ] && ok "marker present in at least one FILE_CHANGED payload" \
    || fail "no FILE_CHANGED event mentions ${MARKER}"

# ── F2: SUBAGENT events (SOFT — model decides whether to use Task) ──────────
echo ""
echo "═══ Test 4 (F2): SUBAGENT_SPAWN/COMPLETE events ═══"
SS=$(dbq "SELECT COUNT(*) FROM runtime_work_item_events
           WHERE work_item_id='$WI' AND event_type='SUBAGENT_SPAWN'")
SC=$(dbq "SELECT COUNT(*) FROM runtime_work_item_events
           WHERE work_item_id='$WI' AND event_type='SUBAGENT_COMPLETE'")
CHILDREN=$(dbq "SELECT COUNT(*) FROM runtime_work_items
                 WHERE parent_work_item_id='$WI'")
echo "  SUBAGENT_SPAWN=$SS  SUBAGENT_COMPLETE=$SC  children=$CHILDREN"

if [ "$SS" -ge 1 ] && [ "$CHILDREN" -ge 1 ]; then
    ok "$SS SUBAGENT_SPAWN event(s), $CHILDREN child work_item(s)"
    [ "$SC" -ge 1 ] && ok "$SC SUBAGENT_COMPLETE event(s)" \
                    || warn "spawn fired but no complete (model may have errored mid-subagent)"
else
    warn "0 SUBAGENT_SPAWN events — model declined to use Task tool (model decision; not a wiring failure)"
    echo "      The wiring is in place: --tools default is on, proto carries Task,"
    echo "      bridge detects tool_use.name=='Task'. If this happens consistently,"
    echo "      try a more explicit prompt or a different model."
fi

# Cleanup
docker compose exec -T database psql -U postgres -d govai_platform -c \
    "DELETE FROM runtime_work_items WHERE id='$WI' OR parent_work_item_id='$WI'" >/dev/null 2>&1 || true

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Subagents + File watch reality-check PASSED" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
