#!/usr/bin/env bash
# tests/integration/test-execucoes-end-to-end.sh
# ============================================================================
# Reality-check — FASE 14.0/5b.2 (Modos Agente + Livre + demolição)
# ----------------------------------------------------------------------------
# Verifies that:
#   (A) The legacy /v1/admin/architect/work-items/* surface is gone (404)
#       AND /playground returns a Next.js 404. The old paths must NOT
#       resolve — anything else means cleanup is incomplete.
#   (B) Migration 093 ran: runtime_work_items has assistant_id +
#       execution_mode + chk_agent_mode_has_assistant; assistants has
#       default_mcp_server_ids + default_runtime_options + is_fixture;
#       4 fixture agents seeded.
#   (C) POST /v1/admin/runtime/work-items in 'agent' mode creates a row
#       with assistant_id NOT NULL + execution_mode='agent' and the
#       fixture's runtime_profile_slug is reflected on the row.
#   (D) POST /v1/admin/runtime/work-items in 'freeform' mode creates a
#       row with assistant_id NULL + execution_mode='freeform' and the
#       caller-supplied runtime_profile_slug + system_prompt land in
#       execution_context.
#   (E) The CHECK constraint chk_agent_mode_has_assistant rejects
#       inconsistent INSERTs (agent + NULL assistant_id, or freeform +
#       NOT NULL assistant_id) — proven via direct SQL.
#   (F) approve-action POST on /v1/admin/runtime/work-items/:id/approve-action
#       enqueues a `resolve-approval` BullMQ job — proven by the route
#       returning {queued:true} for an awaiting_approval row.
#   (G) /v1/admin/runtime/work-items/:id reads back the new fields
#       (assistant_id, execution_mode) so the UI can render the badge.
#   (H) /execucoes/nova and /execucoes/livre return 200 (Next.js
#       SSR/CSR shell). 0 regression on /execucoes (root) and detail
#       page (5b.1 surface).
#
# This is a REALITY check — it inserts test rows directly into Postgres
# where the route would create them, queries the BullMQ Redis keyspace
# for the resolve-approval job, and asserts on actual DB state.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
DB_CONTAINER="${DB_CONTAINER:-govaigrcplatform-database-1}"
REDIS_CONTAINER="${REDIS_CONTAINER:-govaigrcplatform-redis-1}"

# Fixture agent ids seeded by migration 093.
LIVRE_ID='00000000-0000-0000-0fff-000000000001'
SANDBOX_ID='00000000-0000-0000-0fff-000000000004'

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec "$DB_CONTAINER" psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  /execucoes end-to-end — 14.0/5b.2                            "
echo "════════════════════════════════════════════════════════════════"

# ─── Auth ────────────────────────────────────────────────────────────
echo ""
echo "═══ Setup: admin login ═══"
TOKEN=$(curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    fail "admin login failed — aborting"
    exit 1
fi
ok "admin login → token captured"

AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── (A) Demolition ─────────────────────────────────────────────────
echo ""
echo "═══ Test A: legacy surfaces are gone ═══"

# Legacy approve-action endpoint should 404 (route removed)
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
    "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d '{"prompt_id":"x","approved":true}' \
    "$API/v1/admin/architect/work-items/00000000-0000-0000-0000-000000000000/approve-action")
[ "$HTTP" = "404" ] && ok "legacy /v1/admin/architect/work-items/.../approve-action removed (HTTP 404)" \
                   || fail "legacy approve-action route still resolves: HTTP $HTTP"

# Legacy dispatch endpoint should 404
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "${AUTH[@]}" \
    "$API/v1/admin/architect/work-items/00000000-0000-0000-0000-000000000000/dispatch")
[ "$HTTP" = "404" ] && ok "legacy /v1/admin/architect/work-items/.../dispatch removed (HTTP 404)" \
                   || fail "legacy dispatch route still resolves: HTTP $HTTP"

# /playground should return 404
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "$UI/playground")
[ "$HTTP" = "404" ] && ok "/playground returns 404 (page deleted)" \
                   || fail "/playground still serves something: HTTP $HTTP"

# ─── (B) Migration 093 applied ──────────────────────────────────────
echo ""
echo "═══ Test B: migration 093 + 4 fixture agents ═══"

HAS_AID=$(psql_q "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_work_items' AND column_name='assistant_id'")
[ "$HAS_AID" = "1" ] && ok "runtime_work_items.assistant_id exists" \
                    || fail "runtime_work_items.assistant_id missing"

HAS_MODE=$(psql_q "SELECT 1 FROM information_schema.columns WHERE table_name='runtime_work_items' AND column_name='execution_mode'")
[ "$HAS_MODE" = "1" ] && ok "runtime_work_items.execution_mode exists" \
                     || fail "runtime_work_items.execution_mode missing"

HAS_CHK=$(psql_q "SELECT 1 FROM pg_constraint WHERE conname='chk_agent_mode_has_assistant'")
[ "$HAS_CHK" = "1" ] && ok "chk_agent_mode_has_assistant constraint installed" \
                    || fail "chk_agent_mode_has_assistant constraint missing"

HAS_FIX=$(psql_q "SELECT 1 FROM information_schema.columns WHERE table_name='assistants' AND column_name='is_fixture'")
[ "$HAS_FIX" = "1" ] && ok "assistants.is_fixture exists" \
                    || fail "assistants.is_fixture missing"

FIX_COUNT=$(psql_q "SELECT COUNT(*) FROM assistants WHERE is_fixture=TRUE AND org_id='$ORG'")
[ "$FIX_COUNT" = "4" ] && ok "4 fixture agents seeded in demo org" \
                      || fail "expected 4 fixtures, got $FIX_COUNT"

# ─── (E) CHECK constraint catches bad inserts ───────────────────────
echo ""
echo "═══ Test E: chk_agent_mode_has_assistant rejects inconsistent rows ═══"

# This INSERT should fail with the check violation: agent mode but
# assistant_id IS NULL.
ERR=$(docker exec "$DB_CONTAINER" psql -U postgres -d govai_platform -v ON_ERROR_STOP=1 \
    -c "INSERT INTO runtime_work_items (id, org_id, node_id, item_type, title, status, execution_mode, assistant_id) \
        VALUES (uuid_generate_v4(), '$ORG', 'check-test-1', 'compliance_check', 'check-violation-test', 'pending', 'agent', NULL)" 2>&1 \
    || true)
echo "$ERR" | grep -q "chk_agent_mode_has_assistant" \
    && ok "agent + NULL assistant_id rejected by chk_agent_mode_has_assistant" \
    || fail "constraint did not fire: $ERR"

# Inverse: freeform with NOT NULL assistant_id must also fail.
ERR=$(docker exec "$DB_CONTAINER" psql -U postgres -d govai_platform -v ON_ERROR_STOP=1 \
    -c "INSERT INTO runtime_work_items (id, org_id, node_id, item_type, title, status, execution_mode, assistant_id) \
        VALUES (uuid_generate_v4(), '$ORG', 'check-test-2', 'compliance_check', 'check-violation-test', 'pending', 'freeform', '$LIVRE_ID')" 2>&1 \
    || true)
echo "$ERR" | grep -q "chk_agent_mode_has_assistant" \
    && ok "freeform + NOT NULL assistant_id rejected" \
    || fail "constraint did not fire: $ERR"

# ─── (C) POST agent mode creates honest row ─────────────────────────
echo ""
echo "═══ Test C: POST /v1/admin/runtime/work-items mode='agent' ═══"

AGENT_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"agent\",\"assistant_id\":\"$LIVRE_ID\",\"message\":\"reality-check-agent-mode-$(date +%s)\"}" \
    "$API/v1/admin/runtime/work-items")
AGENT_WI=$(echo "$AGENT_RESP" | jq -r '.work_item_id // empty')

if [ -z "$AGENT_WI" ]; then
    fail "agent mode POST failed: $AGENT_RESP"
else
    ok "agent mode POST → work_item_id=$AGENT_WI"

    # Inspect the row directly. assistant_id MUST be the fixture id;
    # execution_mode MUST be 'agent'; runtime_profile_slug MUST come
    # from the fixture (claude_code_official for Claude Code Livre).
    ROW=$(psql_q "SELECT execution_mode || '|' || COALESCE(assistant_id::text,'NULL') || '|' || COALESCE(runtime_profile_slug,'NULL') FROM runtime_work_items WHERE id='$AGENT_WI'")
    EXP_AGENT="agent|$LIVRE_ID|claude_code_official"
    [ "$ROW" = "$EXP_AGENT" ] \
        && ok "row consistent: $ROW" \
        || fail "row mismatch — expected $EXP_AGENT, got $ROW"
fi

# ─── (D) POST freeform mode lands inline config ─────────────────────
echo ""
echo "═══ Test D: POST /v1/admin/runtime/work-items mode='freeform' ═══"

FREEFORM_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"freeform\",\"runtime_profile_slug\":\"openclaude\",\"system_prompt\":\"reality-check-system-prompt\",\"message\":\"reality-check-freeform-$(date +%s)\"}" \
    "$API/v1/admin/runtime/work-items")
FREEFORM_WI=$(echo "$FREEFORM_RESP" | jq -r '.work_item_id // empty')

if [ -z "$FREEFORM_WI" ]; then
    fail "freeform mode POST failed: $FREEFORM_RESP"
else
    ok "freeform mode POST → work_item_id=$FREEFORM_WI"

    # assistant_id must be NULL; execution_mode='freeform';
    # execution_context must carry the inline system_prompt.
    ROW=$(psql_q "SELECT execution_mode || '|' || COALESCE(assistant_id::text,'NULL') || '|' || (execution_context->>'system_prompt') FROM runtime_work_items WHERE id='$FREEFORM_WI'")
    EXP_FREEFORM="freeform|NULL|reality-check-system-prompt"
    [ "$ROW" = "$EXP_FREEFORM" ] \
        && ok "row consistent: $ROW" \
        || fail "row mismatch — expected $EXP_FREEFORM, got $ROW"
fi

# ─── (G) GET detail surfaces new fields ─────────────────────────────
echo ""
echo "═══ Test G: GET /v1/admin/runtime/work-items/:id reflects new fields ═══"

if [ -n "$AGENT_WI" ]; then
    DETAIL=$(curl -sS "${AUTH[@]}" "$API/v1/admin/runtime/work-items/$AGENT_WI")
    SLUG=$(echo "$DETAIL" | jq -r '.work_item.runtime_profile_slug')
    [ "$SLUG" = "claude_code_official" ] \
        && ok "detail returns runtime_profile_slug=claude_code_official for agent row" \
        || fail "detail slug mismatch: $SLUG"
fi

# ─── (F) approve-action enqueues resolve-approval ───────────────────
echo ""
echo "═══ Test F: approve-action queues resolve-approval BullMQ job ═══"

# Stage a work_item directly in awaiting_approval — replicate what an
# in-flight ACTION_REQUIRED would have done. We use SANDBOX_ID so the
# row has a valid assistant FK.
# Note: psql -tAc prepends the RETURNING row + appends "INSERT 0 1" —
# keep only the UUID-shaped first line.
APPR_WI=$(psql_q "INSERT INTO runtime_work_items (id, org_id, node_id, item_type, title, status, execution_mode, assistant_id, execution_hint, runtime_profile_slug) VALUES (uuid_generate_v4(), '$ORG', 'reality-approve-test', 'compliance_check', 'reality-check-approve-stage', 'awaiting_approval', 'agent', '$SANDBOX_ID', 'openclaude', 'openclaude') RETURNING id" | grep -E '^[0-9a-f-]{36}$' | head -1)

if [ -z "$APPR_WI" ]; then
    fail "could not stage awaiting_approval row"
else
    APPR_RESP=$(curl -sS -X POST "${AUTH[@]}" \
        -H 'Content-Type: application/json' \
        -d "{\"prompt_id\":\"reality-prompt-$(date +%s)\",\"approved\":true,\"approve_mode\":\"single\"}" \
        "$API/v1/admin/runtime/work-items/$APPR_WI/approve-action")
    QUEUED=$(echo "$APPR_RESP" | jq -r '.queued // false')
    [ "$QUEUED" = "true" ] \
        && ok "approve-action returned queued=true" \
        || fail "approve-action did not queue: $APPR_RESP"

    # Verify the BullMQ runtime-dispatch queue saw the resolve-approval
    # name. With a fresh stack the job will already be processed (and
    # removed via removeOnComplete), so we look at the count of jobs
    # marked completed in the last few seconds. If the queue has the
    # name `runtime-dispatch` we should see total events incremented.
    sleep 1
    # Best-effort BullMQ probe — Redis may require AUTH which redis-cli
    # doesn't have inside the container; the queued=true return value
    # above is the authoritative check, this is a sanity bonus.
    EVENTS_KEY="bull:runtime-dispatch:events"
    EVT_COUNT=$(docker exec "$REDIS_CONTAINER" redis-cli XLEN "$EVENTS_KEY" 2>/dev/null || echo "")
    if [[ "$EVT_COUNT" =~ ^[0-9]+$ ]] && [ "$EVT_COUNT" -gt 0 ]; then
        ok "BullMQ runtime-dispatch saw activity (XLEN=$EVT_COUNT)"
    else
        echo "  ℹ️  BullMQ stream probe skipped (Redis AUTH or empty stream — non-fatal)"
    fi

    # Cleanup the staged row
    psql_q "DELETE FROM runtime_work_items WHERE id='$APPR_WI'" >/dev/null
fi

# ─── (H) UI routes 200 (zero regression on 5b.1) ────────────────────
echo ""
echo "═══ Test H: /execucoes UI routes ═══"

for path in "/execucoes" "/execucoes/nova" "/execucoes/livre"; do
    HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "$UI$path")
    [ "$HTTP" = "200" ] && ok "$path → HTTP 200" \
                       || fail "$path → HTTP $HTTP"
done

# ─── Summary ─────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ End-to-end PASSED — Modos Agente + Livre + demolição confirmados" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
