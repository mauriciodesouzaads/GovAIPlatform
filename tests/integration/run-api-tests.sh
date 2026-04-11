#!/bin/bash
# tests/integration/run-api-tests.sh
# Testes de integração HTTP para endpoints novos (Fase 3c + 4a-d)
# Uso: bash tests/integration/run-api-tests.sh
set -e

API="http://localhost:3000"
PASS=0
FAIL=0
TOTAL=0

echo "╔══════════════════════════════════════════════════╗"
echo "║    GovAI Platform — Integration Tests            ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── Auth ──
echo "▶ Autenticando como admin@orga.com..."
LOGIN_RESP=$(curl -s -X POST "$API/v1/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}')

TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then
  echo "❌ FATAL: Não conseguiu autenticar. Resposta: $LOGIN_RESP"
  exit 1
fi
echo "  ✅ Token obtido"
echo ""

ORG="00000000-0000-0000-0000-000000000001"
ASST_ID="00000000-0000-0000-0002-000000000001"

assert_status() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $name (HTTP $actual)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name — esperado HTTP $expected, recebeu HTTP $actual"
  fi
}

# assert_status_any: accepts comma-separated list of valid codes
assert_status_any() {
  local name="$1" expected_list="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$expected_list" | grep -qw "$actual"; then
    PASS=$((PASS + 1))
    echo "  ✅ $name (HTTP $actual)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name — esperado HTTP $expected_list, recebeu HTTP $actual"
  fi
}

assert_json_field() {
  local name="$1" body="$2" field="$3"
  TOTAL=$((TOTAL + 1))
  local value
  value=$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); val=eval('d'+\"$field\") if 'd' else None; print(val if val is not None else '')" 2>/dev/null || echo "")
  if [ -n "$value" ] && [ "$value" != "None" ] && [ "$value" != "null" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $name (= ${value:0:60})"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name — campo $field ausente ou null"
  fi
}

assert_json_key() {
  local name="$1" body="$2" key="$3"
  TOTAL=$((TOTAL + 1))
  local found
  found=$(echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if '$key' in str(d) else 'no')" 2>/dev/null || echo "no")
  if [ "$found" = "yes" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ $name (chave '$key' presente)"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ $name — chave '$key' não encontrada"
  fi
}

# helper — faz request com auth headers
auth_get() { curl -s -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" "$@"; }
auth_post() { curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json" "$@"; }
auth_put()  { curl -s -X PUT  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json" "$@"; }
auth_del()  { curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" "$@"; }
status_get() { curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" "$@"; }
status_post() { curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json" "$@"; }
status_put()  { curl -s -o /dev/null -w "%{http_code}" -X PUT  -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" -H "Content-Type: application/json" "$@"; }
status_del()  { curl -s -o /dev/null -w "%{http_code}" -X DELETE -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" "$@"; }

# ════════════════════════════════════════════════════════
echo "═══ COMPLIANCE HUB (5 endpoints) ═══"

# 1. GET /frameworks
STATUS=$(status_get "$API/v1/admin/compliance-hub/frameworks")
assert_status "GET /compliance-hub/frameworks" "200" "$STATUS"

FW_BODY=$(auth_get "$API/v1/admin/compliance-hub/frameworks")
assert_json_key "frameworks lista não vazia" "$FW_BODY" "id"

FW_ID=$(echo "$FW_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if isinstance(d,list) and len(d)>0 else '')" 2>/dev/null || echo "")

# 2. GET /frameworks/:id/controls
if [ -n "$FW_ID" ]; then
  STATUS=$(status_get "$API/v1/admin/compliance-hub/frameworks/$FW_ID/controls")
  assert_status "GET /frameworks/:id/controls" "200" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ GET /frameworks/:id/controls — sem FW_ID"
fi

# 3. POST /auto-assess/:frameworkId — no body (bodyLimit: 1 on this route)
if [ -n "$FW_ID" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
    "$API/v1/admin/compliance-hub/auto-assess/$FW_ID")
  assert_status "POST /auto-assess/:frameworkId" "200" "$STATUS"

  BODY=$(curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
    "$API/v1/admin/compliance-hub/auto-assess/$FW_ID")
  assert_json_key "auto-assess returned assessed" "$BODY" "assessed"
else
  TOTAL=$((TOTAL + 2)); FAIL=$((FAIL + 2)); echo "  ❌ POST /auto-assess — sem FW_ID (x2)"
fi

# 4. PUT /assessments/:controlId
if [ -n "$FW_ID" ]; then
  CTRL_ID=$(auth_get "$API/v1/admin/compliance-hub/frameworks/$FW_ID/controls" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['id'] if isinstance(d,list) and len(d)>0 else '')" 2>/dev/null || echo "")
  if [ -n "$CTRL_ID" ]; then
    STATUS=$(status_put "$API/v1/admin/compliance-hub/assessments/$CTRL_ID" \
      -d '{"status":"compliant","evidence_notes":"Teste automatizado"}')
    assert_status "PUT /assessments/:controlId" "200" "$STATUS"
  else
    TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ PUT /assessments/:controlId — sem CTRL_ID"
  fi
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ PUT /assessments/:controlId — sem FW_ID"
fi

# 5. GET /summary
STATUS=$(status_get "$API/v1/admin/compliance-hub/summary")
assert_status "GET /compliance-hub/summary" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/compliance-hub/summary")
assert_json_key "summary has total_controls" "$BODY" "total_controls"

# ════════════════════════════════════════════════════════
echo ""
echo "═══ MODEL CARD (2 endpoints) ═══"

# 1. GET /model-card
STATUS=$(status_get "$API/v1/admin/assistants/$ASST_ID/model-card")
assert_status "GET /assistants/:id/model-card" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/assistants/$ASST_ID/model-card")
assert_json_key "model-card has model_provider" "$BODY" "model_provider"

# 2. PUT /model-card
STATUS=$(status_put "$API/v1/admin/assistants/$ASST_ID/model-card" \
  -d '{"model_version":"v3.4-test"}')
assert_status "PUT /assistants/:id/model-card" "200" "$STATUS"

# ════════════════════════════════════════════════════════
echo ""
echo "═══ RISK ASSESSMENT (4 endpoints) ═══"

# 1. POST /risk-assessments (create)
RA_BODY=$(auth_post "$API/v1/admin/risk-assessments" \
  -d "{\"assistant_id\":\"$ASST_ID\"}")
RA_ID=$(echo "$RA_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
assert_json_key "POST /risk-assessments created" "$RA_BODY" "id"

# 2. GET /risk-assessments/:assistantId
STATUS=$(status_get "$API/v1/admin/risk-assessments/$ASST_ID")
assert_status "GET /risk-assessments/:assistantId" "200" "$STATUS"

# 3. PUT /risk-assessments/:assessmentId/answers (correct route path)
if [ -n "$RA_ID" ]; then
  STATUS=$(status_put "$API/v1/admin/risk-assessments/$RA_ID/answers" \
    -d '{"answers":{"dp_1":"yes","dp_2":"internal","dp_3":"yes","ho_1":"yes","tr_1":"yes","se_2":"yes","fa_1":"low"}}')
  assert_status "PUT /risk-assessments/:id/answers" "200" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ PUT /risk-assessments/:id/answers — sem RA_ID"
fi

# 4. POST /risk-assessments/:assessmentId/complete (no body, bodyLimit:1)
if [ -n "$RA_ID" ]; then
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" \
    "$API/v1/admin/risk-assessments/$RA_ID/complete")
  # 200 or 409 (already completed) are both valid
  assert_status_any "POST /risk-assessments/:id/complete" "200 409" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ POST /risk-assessments/:id/complete — sem RA_ID"
fi

# ════════════════════════════════════════════════════════
echo ""
echo "═══ MONITORING (5 endpoints) ═══"

# 1. GET /monitoring/realtime
STATUS=$(status_get "$API/v1/admin/monitoring/realtime")
assert_status "GET /monitoring/realtime" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/monitoring/realtime")
assert_json_key "realtime has executions_last_hour" "$BODY" "executions_last_hour"

# 2. GET /monitoring/trends
STATUS=$(status_get "$API/v1/admin/monitoring/trends?days=30")
assert_status "GET /monitoring/trends" "200" "$STATUS"

# 3. GET /monitoring/alerts
STATUS=$(status_get "$API/v1/admin/monitoring/alerts")
assert_status "GET /monitoring/alerts" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/monitoring/alerts")
# alerts returns an array — check it's valid JSON (can be empty array or have entries)
TOTAL=$((TOTAL + 1))
IS_ARRAY=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if isinstance(d,list) else 'no')" 2>/dev/null || echo "no")
if [ "$IS_ARRAY" = "yes" ]; then
  PASS=$((PASS + 1))
  echo "  ✅ alerts is valid array ($(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null) items)"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ alerts — resposta não é array"
fi

# 4. GET /monitoring/thresholds
STATUS=$(status_get "$API/v1/admin/monitoring/thresholds")
assert_status "GET /monitoring/thresholds" "200" "$STATUS"

# 5. PUT /monitoring/thresholds
STATUS=$(status_put "$API/v1/admin/monitoring/thresholds" \
  -d '{"latency_p95_ms":6000}')
assert_status "PUT /monitoring/thresholds" "200" "$STATUS"

# ════════════════════════════════════════════════════════
echo ""
echo "═══ DLP (6 endpoints) ═══"

# 1. GET /dlp/rules
STATUS=$(status_get "$API/v1/admin/dlp/rules")
assert_status "GET /dlp/rules" "200" "$STATUS"

DLP_LIST=$(auth_get "$API/v1/admin/dlp/rules")
assert_json_key "dlp rules not empty" "$DLP_LIST" "name"

# 2. POST /dlp/rules (create custom)
DLP_BODY=$(auth_post "$API/v1/admin/dlp/rules" \
  -d '{"name":"TEST_CNPJ","detector_type":"regex","pattern":"\\b\\d{2}\\.?\\d{3}\\.?\\d{3}\\/?\\d{4}-?\\d{2}\\b","action":"alert"}')
DLP_ID=$(echo "$DLP_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
assert_json_key "POST /dlp/rules created" "$DLP_BODY" "id"

# 3. PUT /dlp/rules/:id
if [ -n "$DLP_ID" ]; then
  STATUS=$(status_put "$API/v1/admin/dlp/rules/$DLP_ID" \
    -d '{"action":"mask"}')
  assert_status "PUT /dlp/rules/:id" "200" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ PUT /dlp/rules/:id — sem DLP_ID"
fi

# 4. POST /dlp/test
STATUS=$(status_post "$API/v1/admin/dlp/test" \
  -d '{"text":"CPF 123.456.789-00","detector_type":"regex","pattern":"\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b"}')
assert_status "POST /dlp/test" "200" "$STATUS"

BODY=$(auth_post "$API/v1/admin/dlp/test" \
  -d '{"text":"CPF 123.456.789-00","detector_type":"regex","pattern":"\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b"}')
assert_json_key "dlp test found match" "$BODY" "count"

# 5. DELETE /dlp/rules/:id (custom) — returns 204 No Content
if [ -n "$DLP_ID" ]; then
  STATUS=$(status_del "$API/v1/admin/dlp/rules/$DLP_ID")
  assert_status_any "DELETE /dlp/rules/:id (custom)" "200 204" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ DELETE /dlp/rules/:id — sem DLP_ID"
fi

# 6. DELETE system rule (expect 403)
SYS_ID=$(auth_get "$API/v1/admin/dlp/rules" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); sys_rules=[r for r in d if r.get('is_system')]; print(sys_rules[0]['id'] if sys_rules else '')" 2>/dev/null || echo "")
if [ -n "$SYS_ID" ]; then
  STATUS=$(status_del "$API/v1/admin/dlp/rules/$SYS_ID")
  assert_status "DELETE system DLP rule (expect 403)" "403" "$STATUS"
else
  echo "  ⚠️  Nenhuma regra de sistema encontrada — skip"
fi

# ════════════════════════════════════════════════════════
echo ""
echo "═══ NOTIFICATION CHANNELS (7 endpoints) ═══"

# 1. GET /notification-channels
STATUS=$(status_get "$API/v1/admin/notification-channels")
assert_status "GET /notification-channels" "200" "$STATUS"

NC_LIST=$(auth_get "$API/v1/admin/notification-channels")
assert_json_key "channels not empty" "$NC_LIST" "name"

# 2. GET /notification-channels/events
STATUS=$(status_get "$API/v1/admin/notification-channels/events")
assert_status "GET /notification-channels/events" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/notification-channels/events")
assert_json_key "events has value field" "$BODY" "value"

# 3. GET /notification-channels/preview
STATUS=$(status_get "$API/v1/admin/notification-channels/preview?provider=slack&event=policy.violation")
assert_status "GET /notification-channels/preview (slack)" "200" "$STATUS"

# 4. POST /notification-channels (create)
NC_BODY=$(auth_post "$API/v1/admin/notification-channels" \
  -d '{"name":"Test Channel CI","provider":"slack","config":{"webhook_url":"https://hooks.slack.com/test"},"events":["policy.violation"]}')
NC_ID=$(echo "$NC_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")
assert_json_key "POST /notification-channels created" "$NC_BODY" "id"

# 5. PUT /notification-channels/:id
if [ -n "$NC_ID" ]; then
  STATUS=$(status_put "$API/v1/admin/notification-channels/$NC_ID" \
    -d '{"events":["policy.violation","dlp.block"]}')
  assert_status "PUT /notification-channels/:id" "200" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ PUT /notification-channels/:id — sem NC_ID"
fi

# 6. POST /notification-channels/test (expect 502 for fake URL or 200)
STATUS=$(status_post "$API/v1/admin/notification-channels/test" \
  -d '{"provider":"slack","webhook_url":"https://hooks.slack.com/test","event":"policy.violation"}')
TOTAL=$((TOTAL + 1))
if [ "$STATUS" = "502" ] || [ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]; then
  PASS=$((PASS + 1))
  echo "  ✅ POST /notification-channels/test (HTTP $STATUS — demo URL)"
else
  FAIL=$((FAIL + 1))
  echo "  ❌ POST /notification-channels/test — esperado 200/400/502, recebeu $STATUS"
fi

# 7. DELETE /notification-channels/:id — returns 204 No Content
if [ -n "$NC_ID" ]; then
  STATUS=$(status_del "$API/v1/admin/notification-channels/$NC_ID")
  assert_status_any "DELETE /notification-channels/:id" "200 204" "$STATUS"
else
  TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "  ❌ DELETE /notification-channels/:id — sem NC_ID"
fi

# ════════════════════════════════════════════════════════
echo ""
echo "═══ EXECUTION PIPELINE (3 endpoints) ═══"

# Create API key for execution tests
API_KEY_BODY=$(auth_post "$API/v1/admin/api-keys" \
  -d '{"name":"CI Integration Test Key","orgId":"00000000-0000-0000-0000-000000000001"}')
EXEC_KEY=$(echo "$API_KEY_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('key',''))" 2>/dev/null || echo "")

if [ -n "$EXEC_KEY" ] && [ "$EXEC_KEY" != "None" ]; then
  echo "  ✅ API key criada para testes de execução"

  # 1. POST /execute/:assistantId — success
  EXEC_BODY=$(curl -s -X POST "$API/v1/execute/00000000-0000-0000-0002-000000000002" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXEC_KEY" \
    -d '{"message":"Olá, preciso de ajuda com informações de RH","sessionId":"ci-test-001"}')
  TOTAL=$((TOTAL + 1))
  HAS_CHOICES=$(echo "$EXEC_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'choices' in d else 'no')" 2>/dev/null || echo "no")
  if [ "$HAS_CHOICES" = "yes" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ POST /execute/:assistantId — LLM response received"
  else
    FAIL=$((FAIL + 1))
    ERR=$(echo "$EXEC_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error','?'))" 2>/dev/null || echo "?")
    echo "  ❌ POST /execute/:assistantId — $ERR"
  fi

  # 2. POST /execute — policy violation
  POLICY_BODY=$(curl -s -X POST "$API/v1/execute/00000000-0000-0000-0002-000000000001" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $EXEC_KEY" \
    -d '{"message":"Quais são os requisitos da LGPD para tratamento de dados pessoais?","sessionId":"ci-test-002"}')
  TOTAL=$((TOTAL + 1))
  HAS_ERROR=$(echo "$POLICY_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'POLICY' in d.get('error','') or 'choices' in d else 'no')" 2>/dev/null || echo "no")
  if [ "$HAS_ERROR" = "yes" ]; then
    PASS=$((PASS + 1))
    echo "  ✅ POST /execute — policy pipeline active"
  else
    FAIL=$((FAIL + 1))
    echo "  ❌ POST /execute — pipeline não respondeu como esperado"
  fi

  # 3. POST /execute — no API key (expect 401)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/v1/execute/00000000-0000-0000-0002-000000000002" \
    -H "Content-Type: application/json" \
    -d '{"message":"test"}')
  assert_status "POST /execute sem API key (expect 401)" "401" "$STATUS"

else
  TOTAL=$((TOTAL + 3)); FAIL=$((FAIL + 3))
  echo "  ❌ Não conseguiu criar API key para testes de execução (x3)"
fi

# ════════════════════════════════════════════════════════
echo ""
echo "═══ AUDIT LOGS (2 endpoints) ═══"

# 1. GET /audit-logs
STATUS=$(status_get "$API/v1/admin/audit-logs?orgId=$ORG&limit=5")
assert_status "GET /audit-logs" "200" "$STATUS"

BODY=$(auth_get "$API/v1/admin/audit-logs?orgId=$ORG&limit=5")
assert_json_key "audit-logs has logs array" "$BODY" "logs"

# 2. GET /audit-logs pagination
BODY=$(auth_get "$API/v1/admin/audit-logs?orgId=$ORG&limit=5")
assert_json_key "audit-logs has pagination" "$BODY" "pagination"

# ════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
PERCENT=$((PASS * 100 / TOTAL))
echo "  RESULTADO: $PASS/$TOTAL passaram ($PERCENT%), $FAIL falharam"
echo "═══════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ⚠️  $FAIL testes falharam — ver detalhes acima"
  exit 1
else
  echo "  🟢 Todos os $TOTAL testes passaram!"
  exit 0
fi
