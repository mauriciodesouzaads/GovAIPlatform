#!/usr/bin/env bash
# ============================================================================
# CORS regression guard — FASE 13.5a2
# ----------------------------------------------------------------------------
# Validates that POST /v1/admin/chat/send/stream (hijacked SSE) echoes
# Access-Control-Allow-Origin when the request has a whitelisted Origin.
#
# Before this fix: 200 OK + valid SSE body, but NO ACAO header, so Chrome
# rejected with "TypeError: Failed to fetch".
#
# Fix: buildCorsHeaders() in src/lib/cors-config.ts used by both
#      server.ts (plugin register) and chat.routes.ts (hijacked writeHead).
#
# See docs/ADR-022-cors-on-hijacked-sse.md for the decision record.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="00000000-0000-0000-0000-000000000001"
ASSISTANT_ID="00000000-0000-0000-0002-000000000003"

TOKEN=$(curl -s -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' \
    | jq -r .token)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "❌ login failed"
    exit 1
fi

echo "═══ Test 1: /chat/send (baseline — should have CORS) ═══"
HEADERS_1=$(curl -s -D - -o /dev/null --max-time 20 \
    -X POST "$API/v1/admin/chat/send" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3001" \
    -d "{\"assistant_id\":\"$ASSISTANT_ID\",\"message\":\"a\",\"model\":\"govai-llm\"}")
if echo "$HEADERS_1" | grep -iq "^access-control-allow-origin: http://localhost:3001"; then
    echo "✅ /chat/send has ACAO (baseline OK)"
else
    echo "❌ /chat/send missing ACAO — regression in baseline"
    echo "$HEADERS_1"
    exit 1
fi

echo ""
echo "═══ Test 2: /chat/send/stream with allowed Origin ═══"
HEADERS_2=$(curl -s -D - -o /dev/null --max-time 20 \
    -X POST "$API/v1/admin/chat/send/stream" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3001" \
    -d "{\"assistant_id\":\"$ASSISTANT_ID\",\"message\":\"a\",\"model\":\"govai-llm\"}")
if echo "$HEADERS_2" | grep -iq "^access-control-allow-origin: http://localhost:3001"; then
    echo "✅ /chat/send/stream has ACAO when origin is allowed (bug fixed)"
else
    echo "❌ /chat/send/stream MISSING ACAO — the fix is not applied"
    echo "────────── response headers ──────────"
    echo "$HEADERS_2"
    exit 1
fi

if echo "$HEADERS_2" | grep -iq "^vary: origin"; then
    echo "✅ /chat/send/stream has Vary: Origin"
else
    echo "❌ /chat/send/stream missing Vary: Origin (required for caching correctness)"
    exit 1
fi

if echo "$HEADERS_2" | grep -iq "^access-control-allow-credentials: true"; then
    echo "✅ /chat/send/stream has ACAC"
else
    echo "❌ /chat/send/stream missing Access-Control-Allow-Credentials"
    exit 1
fi

echo ""
echo "═══ Test 3: /chat/send/stream with NON-allowed Origin (must NOT echo) ═══"
HEADERS_3=$(curl -s -D - -o /dev/null --max-time 20 \
    -X POST "$API/v1/admin/chat/send/stream" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -H "Origin: https://evil.example" \
    -d "{\"assistant_id\":\"$ASSISTANT_ID\",\"message\":\"a\",\"model\":\"govai-llm\"}")
if echo "$HEADERS_3" | grep -iq "^access-control-allow-origin: https://evil.example"; then
    echo "❌ /chat/send/stream echoed a non-allowed origin — SECURITY REGRESSION"
    exit 1
else
    echo "✅ /chat/send/stream correctly rejects non-allowed origin (no ACAO echoed)"
fi

echo ""
echo "═══ Test 4: SSE body still arrives in sub-20s ═══"
BODY=$(curl -s --max-time 20 \
    -X POST "$API/v1/admin/chat/send/stream" \
    -H "Authorization: Bearer $TOKEN" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -H "Origin: http://localhost:3001" \
    -d "{\"assistant_id\":\"$ASSISTANT_ID\",\"message\":\"quanto e 2+2, em uma palavra\",\"model\":\"govai-llm\"}")
if echo "$BODY" | grep -q '"done":true'; then
    echo "✅ SSE stream completed with {\"done\":true} frame"
else
    echo "❌ SSE stream body does not contain done=true"
    echo "──── body preview ────"
    echo "$BODY" | head -c 600
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ ALL 4 TESTS PASSED — FASE 13.5a2 fix verified"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
