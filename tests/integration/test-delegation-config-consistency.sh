#!/usr/bin/env bash
# tests/integration/test-delegation-config-consistency.sh
# ----------------------------------------------------------------------------
# FASE 13.5b.1 — UX hotfix regression guard
#
# Two invariants this test protects:
#
#   1. /v1/admin/assistants/available's `delegation_enabled` serializer
#      agrees with what shouldDelegate() will actually do at runtime.
#      The bug we fixed had delegation_enabled=true when the underlying
#      patterns array was empty — shouldDelegate then returned
#      reason='no_patterns' and every message silently fell through.
#
#   2. The three runtime-prefix escape hatches — [OPENCLAUDE],
#      [CLAUDE_CODE], [AIDER] — are present in auto_delegate_patterns
#      for every delegation-enabled assistant on the demo org. Without
#      them, the prefix does nothing (not a delegation trigger, not a
#      runtime hint — nothing), which is the exact trap this hotfix
#      closes.
#
# This test hits the public API (loopback) plus the DB. It does NOT
# spawn an Aider run — the expensive end-to-end is covered by
# test-runtime-produces-artifacts.sh in 13.5b/3. Here we only validate
# the contract between config and serializer.
# ----------------------------------------------------------------------------
set -e

API="${API:-http://localhost:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@orga.com}"
ADMIN_PASS="${ADMIN_PASS:-GovAI2026@Admin}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
DEMO_ASSISTANT="${DEMO_ASSISTANT:-00000000-0000-0000-0002-000000000001}"

# DB access goes through `docker compose exec database psql` (not
# host-side DATABASE_URL) so we inherit the postgres superuser's trust
# auth inside the container — no password plumbing. Matches the pattern
# used by test-openclaude-e2e.sh and test-runtime-produces-artifacts.sh.
dbq() {
    docker compose exec -T database psql -U postgres -d govai_platform -tAc "$1"
}

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

echo ""
echo "═════════════════════════════════════════════════════════════"
echo "  DELEGATION CONFIG CONSISTENCY — 13.5b.1 regression guard   "
echo "═════════════════════════════════════════════════════════════"
echo ""

# ── Login ───────────────────────────────────────────────────────────────────
TOKEN=$(curl -s -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.token // empty')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ Falha ao autenticar como $ADMIN_EMAIL"
    exit 1
fi

H=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json")

# ── Test 1: serializer consistency ──────────────────────────────────────────
# delegation_enabled in the API response must be true ONLY when the
# underlying config has both enabled=true AND a non-empty pattern array.
echo "═══ Test 1: /assistants/available serializer consistency ═══"
RESP=$(curl -sf "${H[@]}" "$API/v1/admin/assistants/available")

INCONSISTENT=$(echo "$RESP" | jq '[.[] |
    select(
        (.delegation_enabled == true) and
        (((.delegation_config.enabled != true)) or
         ((.delegation_config.auto_delegate_patterns // []) | length) == 0)
    ) |
    {id, name, delegation_enabled, dc_enabled: .delegation_config.enabled,
     pattern_count: ((.delegation_config.auto_delegate_patterns // []) | length)}
]')
INCONSISTENT_COUNT=$(echo "$INCONSISTENT" | jq 'length')
check "no assistant has delegation_enabled=true without real patterns" "0" "$INCONSISTENT_COUNT"
if [ "$INCONSISTENT_COUNT" != "0" ]; then
    echo "    Divergências encontradas:"
    echo "$INCONSISTENT" | jq .
fi

# ── Test 2: prefix patterns present on demo Assistente Jurídico ─────────────
# Post-migration 087, the demo assistant must carry [OPENCLAUDE],
# [CLAUDE_CODE], and [AIDER] tokens. We check the raw JSONB (not the
# API) because the API doesn't expose the patterns for security — they
# live on the delegation_config blob that admins see.
echo ""
echo "═══ Test 2: migration 087 patterns present on demo assistant ═══"

patterns=$(dbq "
    SELECT delegation_config->'auto_delegate_patterns'
      FROM assistants
     WHERE id = '$DEMO_ASSISTANT' AND org_id = '$ORG';
")

has_token() {
    local token="$1"
    echo "$patterns" | grep -q "$token" && echo "true" || echo "false"
}

check "[OPENCLAUDE] token present"  "true" "$(has_token 'OPENCLAUDE')"
check "[CLAUDE_CODE] token present" "true" "$(has_token 'CLAUDE_CODE')"
check "[AIDER] token present"       "true" "$(has_token 'AIDER')"

# ── Test 3: runtimeFromPrefix routing end-to-end ────────────────────────────
# Send a message with [AIDER] prefix via /chat/send and verify the
# created work item carries runtime_profile_slug='aider'. Do NOT wait
# for aider to finish — this test is about the routing decision.
#
# Skip conditions:
#   - aider runtime profile not registered (migration 086 not applied)
#   - aider-runner container not up (fresh dev box without the profile)
# Both degrade gracefully: the test logs a skip and does not fail CI.
echo ""
echo "═══ Test 3: [AIDER] prefix → runtime_profile_slug=aider ═══"

AIDER_REGISTERED=$(dbq "
    SELECT COUNT(*) FROM runtime_profiles
     WHERE slug = 'aider' AND status = 'active';
" 2>/dev/null || echo 0)

if [ "$AIDER_REGISTERED" != "1" ]; then
    echo "  ⏭  SKIP — aider runtime_profile not active (migration 086 pending?)"
else
    RESP=$(curl -sf "${H[@]}" -X POST "$API/v1/admin/chat/send" \
        -d "{\"assistant_id\":\"$DEMO_ASSISTANT\",\"message\":\"[AIDER] regression probe — do not execute\",\"force_delegate\":false}" \
        || echo '{}')

    # /v1/admin/chat/send returns the pipeline's chat-completions-shaped
    # response. Delegated runs embed the new work item id in the
    # assistant message's content as `Work Item ID: \`<uuid>\``. Extract
    # that UUID — it's what the UI renders in the delegation card.
    WORK_ITEM_ID=$(echo "$RESP" \
        | jq -r '.choices[0].message.content // ""' \
        | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
        | head -1)

    if [ -z "$WORK_ITEM_ID" ]; then
        # [AIDER] alone doesn't trigger delegation if the pattern is
        # missing (migration 087 guards this). Report as FAIL rather
        # than skip — this is exactly the bug we're guarding.
        TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
        echo "  ❌ [AIDER]-prefixed message did NOT create a delegated work item"
        echo "     Response: $(echo "$RESP" | head -c 400)"
    else
        SLUG=$(dbq "
            SELECT runtime_profile_slug
              FROM runtime_work_items
             WHERE id = '$WORK_ITEM_ID';
        " | tr -d '[:space:]')
        check "work item runtime_profile_slug == aider" "aider" "$SLUG"
    fi
fi

# ── Test 4: [OPENCLAUDE] still routes to openclaude (back-compat) ───────────
echo ""
echo "═══ Test 4: [OPENCLAUDE] prefix → runtime_profile_slug=openclaude ═══"

RESP=$(curl -sf "${H[@]}" -X POST "$API/v1/admin/chat/send" \
    -d "{\"assistant_id\":\"$DEMO_ASSISTANT\",\"message\":\"[OPENCLAUDE] regression probe — do not execute\",\"force_delegate\":false}" \
    || echo '{}')

# Same extraction shape as Test 3 — UUID sits inside the markdown
# body of the chat-completions response.
WORK_ITEM_ID=$(echo "$RESP" \
    | jq -r '.choices[0].message.content // ""' \
    | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
    | head -1)

if [ -z "$WORK_ITEM_ID" ]; then
    TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1))
    echo "  ❌ [OPENCLAUDE]-prefixed message did NOT create a delegated work item"
else
    SLUG=$(dbq "
        SELECT runtime_profile_slug
          FROM runtime_work_items
         WHERE id = '$WORK_ITEM_ID';
    " | tr -d '[:space:]')
    check "work item runtime_profile_slug == openclaude" "openclaude" "$SLUG"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════"
echo "  Resultado: $PASS / $TOTAL passou ($FAIL falhas)"
echo "════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
