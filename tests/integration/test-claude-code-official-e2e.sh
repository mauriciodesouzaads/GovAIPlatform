#!/bin/bash
# ============================================================================
# tests/integration/test-claude-code-official-e2e.sh
# ----------------------------------------------------------------------------
# FASE 9 — Validates the Claude Code Official runner end-to-end.
#
# Requires:
#   - ANTHROPIC_API_KEY set in environment (real key with credits)
#   - docker compose running with --profile official
#   - The GovAI stack running with CLAUDE_CODE_GRPC_HOST + socket path set
#
# If ANTHROPIC_API_KEY is absent, the script skips with exit 0 and a clear
# log message (CI can mark as skipped, not failed).
# ============================================================================

set -uo pipefail

ORG="00000000-0000-0000-0000-000000000001"
ASST_ID="00000000-0000-0000-0002-000000000001"

# ── Precondition: ANTHROPIC_API_KEY ──
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "⏭️  SKIP: ANTHROPIC_API_KEY not set — cannot validate Claude Code Official runner"
    echo "   This is expected in CI without Anthropic credentials."
    echo "   To run locally: export ANTHROPIC_API_KEY=sk-ant-... && bash $0"
    exit 0
fi

echo "═══════════════════════════════════════"
echo "  Claude Code Official Runner E2E"
echo "═══════════════════════════════════════"

# ── Step 1: Start container ──
echo ""
echo "→ Step 1: Starting claude-code-runner container..."
docker compose --profile official up -d claude-code-runner 2>&1 | tail -3

# Wait for healthy
STATUS=""
for i in $(seq 1 20); do
    STATUS=$(docker compose --profile official ps claude-code-runner --format "{{.Status}}" 2>/dev/null || echo "starting")
    echo "  Poll $i: $STATUS"
    echo "$STATUS" | grep -q "healthy" && break
    sleep 5
done

if ! echo "$STATUS" | grep -q "healthy"; then
    echo "❌ FAIL: claude-code-runner did not become healthy"
    docker compose logs claude-code-runner --tail 30
    exit 1
fi
echo "  ✓ Container healthy"

# ── Step 2: Auth ──
echo ""
echo "→ Step 2: Authenticating..."
TOKEN=$(curl -s -X POST http://localhost:3000/v1/admin/login \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token 2>/dev/null)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ FAIL: could not obtain auth token"
    exit 1
fi
echo "  ✓ Token obtained"

H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json")

# ── Step 3: Verify runtime availability ──
echo ""
echo "→ Step 3: Checking claude_code_official availability..."
AVAILABLE=$(curl -s http://localhost:3000/v1/admin/runtimes "${H[@]}" | \
    jq -r '[.[] | select(.slug == "claude_code_official")][0].available')
echo "  claude_code_official.available = $AVAILABLE"

if [ "$AVAILABLE" != "true" ]; then
    echo "❌ FAIL: runtime not reported as available despite container healthy"
    echo "  This may mean the socket file was not created. Check:"
    echo "    docker compose exec api ls -la /var/run/govai/"
    exit 1
fi
echo "  ✓ Runtime available"

# ── Step 4: Dispatch work item ──
echo ""
echo "→ Step 4: Dispatching simple prompt via Official runtime..."
PROMPT="Responda exatamente esta palavra e nada mais: pronto"
RESULT=$(curl -s -X POST http://localhost:3000/v1/admin/chat/send "${H[@]}" \
    -d "{\"assistant_id\":\"$ASST_ID\",\"message\":\"$PROMPT\",\"force_delegate\":true,\"runtime_profile\":\"claude_code_official\"}")

WI_ID=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_govai',{}).get('workItemId',''))" 2>/dev/null)
if [ -z "$WI_ID" ]; then
    echo "❌ FAIL: dispatch did not return workItemId"
    echo "Response: $(echo "$RESULT" | head -c 500)"
    exit 1
fi
echo "  ✓ workItemId=$WI_ID"

# ── Step 5: Poll until done or timeout ──
echo ""
echo "→ Step 5: Polling until done (max 120s)..."
DONE=false
STATUS=""
for i in $(seq 1 40); do
    sleep 3
    ROW=$(docker compose exec -T database psql -U postgres -d govai_platform -t -A -F'|' -c \
        "SELECT status, runtime_profile_slug, runtime_claim_level FROM architect_work_items WHERE id = '$WI_ID'" 2>/dev/null)
    STATUS=$(echo "$ROW" | cut -d'|' -f1)
    RUNTIME=$(echo "$ROW" | cut -d'|' -f2)
    CLAIM=$(echo "$ROW" | cut -d'|' -f3)
    echo "  Poll $i: status=$STATUS runtime=$RUNTIME claim=$CLAIM"

    if [ "$STATUS" = "done" ]; then
        DONE=true
        break
    fi
    if [ "$STATUS" = "blocked" ] || [ "$STATUS" = "cancelled" ]; then
        echo "❌ FAIL: work item ended in $STATUS"
        docker compose exec -T database psql -U postgres -d govai_platform -c \
            "SELECT dispatch_error FROM architect_work_items WHERE id = '$WI_ID'"
        exit 1
    fi
done

if [ "$DONE" != "true" ]; then
    echo "❌ FAIL: work item did not reach done within 120s"
    exit 1
fi

# ── Step 6: Validate output ──
echo ""
echo "→ Step 6: Validating persisted output..."

FULL_TEXT=$(docker compose exec -T database psql -U postgres -d govai_platform -t -A -c \
    "SELECT execution_context->'output'->>'fullText' FROM architect_work_items WHERE id = '$WI_ID'" 2>/dev/null)
CLAIM=$(docker compose exec -T database psql -U postgres -d govai_platform -t -A -c \
    "SELECT runtime_claim_level FROM architect_work_items WHERE id = '$WI_ID'" 2>/dev/null)
RUNTIME=$(docker compose exec -T database psql -U postgres -d govai_platform -t -A -c \
    "SELECT runtime_profile_slug FROM architect_work_items WHERE id = '$WI_ID'" 2>/dev/null)
EVENT_COUNT=$(docker compose exec -T database psql -U postgres -d govai_platform -t -A -c \
    "SELECT count(*) FROM architect_work_item_events WHERE work_item_id = '$WI_ID'" 2>/dev/null)

echo "  runtime_claim_level = $CLAIM"
echo "  runtime_profile     = $RUNTIME"
echo "  fullText length     = ${#FULL_TEXT}"
echo "  event_count         = $EVENT_COUNT"

FAILED=0

if [ "$(echo "$CLAIM" | tr -d '[:space:]')" != "official_cli_governed" ]; then
    echo "  ❌ expected claim=official_cli_governed, got '$CLAIM'"
    FAILED=1
fi
if [ "$(echo "$RUNTIME" | tr -d '[:space:]')" != "claude_code_official" ]; then
    echo "  ❌ expected runtime=claude_code_official, got '$RUNTIME'"
    FAILED=1
fi
if [ -z "$FULL_TEXT" ] || [ ${#FULL_TEXT} -lt 3 ]; then
    echo "  ❌ fullText empty or too short (${#FULL_TEXT} chars)"
    FAILED=1
else
    echo "  ✓ fullText: ${FULL_TEXT:0:80}"
fi
if [ "$EVENT_COUNT" -lt 2 ]; then
    echo "  ❌ too few events ($EVENT_COUNT, expected >= 2)"
    FAILED=1
else
    echo "  ✓ $EVENT_COUNT events recorded"
fi

echo ""
if [ $FAILED -eq 0 ]; then
    echo "═══════════════════════════════════════"
    echo "  ✅ Claude Code Official E2E PASSED"
    echo "═══════════════════════════════════════"
    exit 0
else
    echo "═══════════════════════════════════════"
    echo "  ❌ Claude Code Official E2E FAILED"
    echo "═══════════════════════════════════════"
    exit 1
fi
