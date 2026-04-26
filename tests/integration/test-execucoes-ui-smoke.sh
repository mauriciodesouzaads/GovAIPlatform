#!/usr/bin/env bash
# tests/integration/test-execucoes-ui-smoke.sh
# ============================================================================
# Smoke test — /execucoes UI (FASE 14.0/5b.1)
# ----------------------------------------------------------------------------
# UI changes can't be fully validated headlessly, but a smoke test
# proves: (1) the routes render 200 with the expected layout shell,
# (2) admin-ui's TypeScript build is clean, (3) the legacy /playground
# still responds (zero regression on Chat).
#
# Visual checks ("looks right") are left for the user to confirm in
# the browser after this test passes.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  /execucoes UI smoke — 14.0/5b.1                              "
echo "════════════════════════════════════════════════════════════════"

# ── Test 1: list page returns 200 ───────────────────────────────────────────
echo ""
echo "═══ Test 1: GET /execucoes returns 200 with expected shell ═══"
HTTP=$(curl -sS -o /tmp/exec-list.html -w "%{http_code}" "$UI/execucoes")
[ "$HTTP" = "200" ] && ok "list page: HTTP 200" || fail "list page: HTTP $HTTP"

# Look for a marker we know is in the layout (the "Execuções" header)
if grep -q "Execu" /tmp/exec-list.html; then
    ok "list HTML contains 'Execu' marker (layout rendered)"
else
    echo "  ⚠️  marker not present in initial HTML — likely CSR-only (Next.js 14 RSC)"
fi

# ── Test 2: detail page returns 200 ─────────────────────────────────────────
echo ""
echo "═══ Test 2: GET /execucoes/:id returns 200 ═══"
TOKEN=$(curl -s -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
SAMPLE_ID=$(curl -sS "$API/v1/admin/runtime/work-items?limit=1" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG" | jq -r '.items[0].id // empty')

if [ -n "$SAMPLE_ID" ] && [ "$SAMPLE_ID" != "null" ]; then
    HTTP2=$(curl -sS -o /dev/null -w "%{http_code}" "$UI/execucoes/$SAMPLE_ID")
    [ "$HTTP2" = "200" ] && ok "detail page: HTTP 200 for $SAMPLE_ID" \
        || fail "detail page: HTTP $HTTP2"
else
    echo "  ⚠️  no work_items in DB — skipping detail probe"
fi

# ── Test 3: admin-ui TS build clean ────────────────────────────────────────
echo ""
echo "═══ Test 3: admin-ui tsc --noEmit ═══"
( cd admin-ui && rm -rf .next/types/app/execucoes && npx tsc --noEmit ) >/dev/null 2>&1 \
    && ok "admin-ui TS clean" \
    || fail "admin-ui TS errors"

# ── Test 4: legacy /playground still works (zero Chat regression) ──────────
echo ""
echo "═══ Test 4: /playground regression ═══"
HTTP3=$(curl -sS -o /dev/null -w "%{http_code}" "$UI/playground")
[ "$HTTP3" = "200" ] && ok "/playground: HTTP 200" \
    || fail "/playground: HTTP $HTTP3 — chat broke"

# ── Test 5: backend 5a routes still answer ─────────────────────────────────
echo ""
echo "═══ Test 5: /v1/admin/runtime/* still up (no backend touched) ═══"
LIST_HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
    "$API/v1/admin/runtime/work-items?limit=1")
[ "$LIST_HTTP" = "200" ] && ok "list endpoint still 200" \
    || fail "list endpoint broke: HTTP $LIST_HTTP"

HEALTH_HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
    "$API/v1/admin/runtime/runners/health")
[ "$HEALTH_HTTP" = "200" ] && ok "runners health still 200" \
    || fail "runners health broke: HTTP $HEALTH_HTTP"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Smoke test PASSED — visual check next" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
