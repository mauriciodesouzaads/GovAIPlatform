#!/usr/bin/env bash
# ============================================================================
# Shield Level Change E2E — FASE 13.5a
# ----------------------------------------------------------------------------
# Walks the full acknowledgment flow:
#   1. GET /notice for the 1→3 transition → obtain SHA-256 hash
#   2. POST /change with hash + acknowledgment text → expect success +
#      evidence_record id
#   3. GET / → verify new level AND non-empty history
#   4. Revert via another round-trip (3→1) so subsequent integration
#      tests see the stack at level 1 (our default)
#
# Exits non-zero on any step failure. Prints each assertion so CI logs
# stay readable.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@orga.com}"
ADMIN_PASS="${ADMIN_PASS:-GovAI2026@Admin}"

fail() { echo "❌ $*" >&2; exit 1; }
ok()   { echo "✅ $*"; }

echo "═══ Step 1: Authenticate ═══"
TOKEN=$(curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "login failed"
ok "logged in"

AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json")

echo ""
echo "═══ Step 2: Baseline — current level + history ═══"
STATE=$(curl -sS "$API/v1/admin/shield-level" "${AUTH[@]}")
BASE_LEVEL=$(echo "$STATE" | jq -r '.current.shield_level')
[ "$BASE_LEVEL" = "1" ] || fail "expected baseline shield_level=1, got $BASE_LEVEL"
ok "baseline shield_level=1"

echo ""
echo "═══ Step 3: GET notice 1→3 (pt-BR) ═══"
NOTICE=$(curl -sS "$API/v1/admin/shield-level/notice?from=1&to=3&locale=pt-BR" "${AUTH[@]}")
HASH=$(echo "$NOTICE" | jq -r '.template_hash')
CHARS=$(echo "$NOTICE" | jq -r '.template_content | length')
[ -n "$HASH" ] && [ "$HASH" != "null" ] || fail "no template_hash returned"
[ "$CHARS" -gt 500 ] || fail "template content suspiciously short: $CHARS chars"
ok "notice hash=${HASH:0:12}… ($CHARS chars)"

echo ""
echo "═══ Step 4: POST change 1→3 ═══"
CHANGE=$(curl -sS -X POST "$API/v1/admin/shield-level/change" "${AUTH[@]}" \
    -d "$(jq -n --arg h "$HASH" '{new_level:3,template_hash:$h,acknowledgment:"Entendi e autorizo",locale:"pt-BR"}')")
SUCCESS=$(echo "$CHANGE" | jq -r '.success')
EV_ID=$(echo "$CHANGE" | jq -r '.evidence_record_id')
[ "$SUCCESS" = "true" ] || fail "change failed: $(echo $CHANGE | jq -c .)"
[ -n "$EV_ID" ] && [ "$EV_ID" != "null" ] || fail "no evidence_record_id returned"
ok "change applied, evidence_record_id=${EV_ID:0:12}…"

echo ""
echo "═══ Step 5: Verify new level + history entry ═══"
STATE=$(curl -sS "$API/v1/admin/shield-level" "${AUTH[@]}")
NEW_LEVEL=$(echo "$STATE" | jq -r '.current.shield_level')
HIST_LEN=$(echo "$STATE" | jq -r '.history | length')
[ "$NEW_LEVEL" = "3" ] || fail "expected shield_level=3, got $NEW_LEVEL"
[ "$HIST_LEN" -ge 1 ] || fail "expected history length >= 1, got $HIST_LEN"
ok "shield_level=3, history=$HIST_LEN row(s)"

echo ""
echo "═══ Step 6: Hash-mismatch guard (409) ═══"
HTTP=$(curl -sS -o /tmp/shield-mismatch.json -w "%{http_code}" -X POST \
    "$API/v1/admin/shield-level/change" "${AUTH[@]}" \
    -d '{"new_level":1,"template_hash":"0000000000000000000000000000000000000000000000000000000000000000","acknowledgment":"tampered","locale":"pt-BR"}')
[ "$HTTP" = "409" ] || fail "expected 409 on hash mismatch, got $HTTP (body: $(cat /tmp/shield-mismatch.json))"
ok "mismatched hash rejected with 409"

echo ""
echo "═══ Step 7: Revert 3→1 (for regression stability) ═══"
REVERT_NOTICE=$(curl -sS "$API/v1/admin/shield-level/notice?from=3&to=1&locale=pt-BR" "${AUTH[@]}")
REVERT_HASH=$(echo "$REVERT_NOTICE" | jq -r '.template_hash')
REVERT=$(curl -sS -X POST "$API/v1/admin/shield-level/change" "${AUTH[@]}" \
    -d "$(jq -n --arg h "$REVERT_HASH" '{new_level:1,template_hash:$h,acknowledgment:"revert",locale:"pt-BR"}')")
echo "$REVERT" | jq -r '.success' | grep -qx true || fail "revert failed: $(echo $REVERT | jq -c .)"

FINAL=$(curl -sS "$API/v1/admin/shield-level" "${AUTH[@]}" | jq -r '.current.shield_level')
[ "$FINAL" = "1" ] || fail "expected final shield_level=1, got $FINAL"
ok "reverted to shield_level=1"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTADO: 7/7 passaram"
echo "═══════════════════════════════════════════════════"
echo "  🟢 Shield level change E2E passed"
