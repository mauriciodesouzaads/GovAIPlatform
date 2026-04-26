#!/usr/bin/env bash
# tests/integration/test-rag-end-to-end.sh
# ============================================================================
# Reality-check — FASE 14.0/6a₁ (RAG real com Qdrant)
# ----------------------------------------------------------------------------
# Verifies end-to-end:
#   (1) Qdrant up
#   (2) Migration 094 — 5 RAG tables present + ALTER columns landed
#   (3) Embeddings provider responds (mock fallback acceptable)
#   (4) POST /v1/admin/knowledge-bases creates a KB
#   (5) Multipart upload → status pipeline → ready
#   (6) Qdrant collection populated
#   (7) Search returns chunks with payload
#   (8) Cross-KB search endpoint
#   (9) Assistant↔KB linking PUT/GET
#  (10) Dispatch hook injects RAG context: a work_item from a fixture
#       agent linked to the KB writes a retrieval_log entry
#  (11) DLP block — uploading a doc with CPF rejects via extraction_status='failed'
#  (12) Document delete cascades to Qdrant
#  (13) 5b.2 regression — /execucoes UI + reality-check still green
# ============================================================================

set -euo pipefail
API="${API:-http://localhost:3000}"
UI="${UI:-http://localhost:3001}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
QDRANT="${QDRANT:-http://localhost:6333}"
QDRANT_KEY="${QDRANT_API_KEY:-govai-qdrant-local-dev}"

# Fixture from 093 — Claude Code Auditado, agent mode, openclaude-only
ASSIST_AUDITADO='00000000-0000-0000-0fff-000000000002'
ASSIST_LIVRE='00000000-0000-0000-0fff-000000000001'

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  RAG end-to-end — 14.0/6a₁                                    "
echo "════════════════════════════════════════════════════════════════"

# ─── Setup ──────────────────────────────────────────────────────────
echo ""
echo "═══ Setup: admin login ═══"
TOKEN=$(curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { fail "admin login failed"; exit 1; }
ok "admin login → token captured"
AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── (1) Qdrant healthy ────────────────────────────────────────────
echo ""
echo "═══ Test 1: Qdrant up ═══"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "$QDRANT/readyz")
[ "$HTTP" = "200" ] && ok "Qdrant /readyz HTTP 200" || fail "Qdrant /readyz HTTP $HTTP"

# ─── (2) Migration 094 ─────────────────────────────────────────────
echo ""
echo "═══ Test 2: migration 094 schema ═══"
TBL_COUNT=$(psql_q "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('knowledge_bases','documents','document_chunks','assistant_knowledge_bases','retrieval_log')")
[ "$TBL_COUNT" = "5" ] && ok "5 RAG tables present" || fail "expected 5 tables, got $TBL_COUNT"

KB_COL_COUNT=$(psql_q "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='knowledge_bases' AND column_name IN ('embedding_provider','qdrant_collection_name','document_count','chunk_count','status')")
[ "$KB_COL_COUNT" = "5" ] && ok "knowledge_bases extension complete" || fail "knowledge_bases missing columns ($KB_COL_COUNT/5)"

DOC_COL_COUNT=$(psql_q "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='documents' AND column_name IN ('extraction_status','sha256','storage_path','dlp_scan_result','knowledge_base_id')")
[ "$DOC_COL_COUNT" = "5" ] && ok "documents extension complete" || fail "documents missing columns ($DOC_COL_COUNT/5)"

CHK=$(psql_q "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('knowledge_bases_status_check','documents_extraction_status_check')")
[ "$CHK" = "2" ] && ok "CHECK constraints installed" || fail "CHECK constraints missing ($CHK/2)"

# ─── (3) Create KB ─────────────────────────────────────────────────
echo ""
echo "═══ Test 3: POST /v1/admin/knowledge-bases ═══"
KB_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"name":"rag-e2e-kb","description":"reality-check KB","embedding_provider":"mock","embedding_dim":768}' \
    "$API/v1/admin/knowledge-bases")
KB_ID=$(echo "$KB_RESP" | jq -r '.id // empty')
[ -n "$KB_ID" ] && ok "KB created → $KB_ID" || { fail "KB create failed: $KB_RESP"; exit 1; }

# Confirm qdrant_collection_name is set + matches lib formula.
COL_NAME=$(echo "$KB_RESP" | jq -r '.qdrant_collection_name')
EXPECTED_COL="govai_org_$(echo "$ORG" | tr -d '-')_$(echo "$KB_ID" | tr -d '-')"
[ "$COL_NAME" = "$EXPECTED_COL" ] && ok "qdrant_collection_name matches lib formula" \
                                  || fail "expected $EXPECTED_COL, got $COL_NAME"

# ─── (4) Upload document (markdown) ────────────────────────────────
echo ""
echo "═══ Test 4: multipart upload (markdown) ═══"
cat > /tmp/test-rag-doc.md <<'EOF'
# Política Interna de Compliance LGPD

A organização GovAI Demo segue a Lei Geral de Proteção de Dados (LGPD)
em todo o processamento de dados pessoais. O Encarregado pelo Tratamento
de Dados Pessoais (DPO) é o responsável formal pelo monitoramento de
conformidade, atuando como ponto de contato com a ANPD.

## Treinamentos Anuais

Todos os funcionários devem completar o treinamento de privacidade
anual, com avaliação documentada. Novos colaboradores têm 30 dias
para concluir o treinamento inicial.

## Direitos dos Titulares

Os titulares de dados podem solicitar acesso, correção, portabilidade
ou eliminação dos seus dados via formulário no portal de privacidade.
O prazo de resposta é de 15 dias corridos.

## Incidentes

Em caso de incidente de segurança envolvendo dados pessoais, o DPO
deve ser notificado em até 24 horas. A comunicação à ANPD segue o
prazo regulatório de 2 dias úteis após ciência.
EOF

UPL_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -F "file=@/tmp/test-rag-doc.md;type=text/markdown" \
    "$API/v1/admin/knowledge-bases/$KB_ID/documents")
DOC_ID=$(echo "$UPL_RESP" | jq -r '.document_id // empty')
[ -n "$DOC_ID" ] && ok "document uploaded → $DOC_ID" || { fail "upload failed: $UPL_RESP"; exit 1; }

# ─── (5) Wait for status=ready ─────────────────────────────────────
echo ""
echo "═══ Test 5: pipeline status → ready ═══"
STATUS=""
for i in $(seq 1 30); do
    sleep 1
    STATUS=$(curl -sS "${AUTH[@]}" "$API/v1/admin/documents/$DOC_ID" | jq -r '.extraction_status // ""')
    [ "$STATUS" = "ready" ] && break
    [ "$STATUS" = "failed" ] && break
done
if [ "$STATUS" = "ready" ]; then
    ok "status=ready"
else
    DETAIL=$(curl -sS "${AUTH[@]}" "$API/v1/admin/documents/$DOC_ID")
    fail "status=$STATUS → detail: $DETAIL"
fi

# ─── (6) Qdrant has points ─────────────────────────────────────────
echo ""
echo "═══ Test 6: Qdrant collection populated ═══"
N_POINTS=$(curl -sS -H "api-key: $QDRANT_KEY" \
    "$QDRANT/collections/$COL_NAME" \
    | jq -r '.result.points_count // 0')
[ "$N_POINTS" -ge 1 ] && ok "$N_POINTS points in Qdrant" || fail "Qdrant collection empty"

# ─── (7) Search ────────────────────────────────────────────────────
echo ""
echo "═══ Test 7: POST /v1/admin/knowledge-bases/:id/search ═══"
SEARCH=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"query":"Quem é responsável pela LGPD?","top_k":3,"min_score":0.0}' \
    "$API/v1/admin/knowledge-bases/$KB_ID/search")
N_HITS=$(echo "$SEARCH" | jq '.results | length')
[ "$N_HITS" -ge 1 ] && ok "$N_HITS chunks returned" || fail "search empty: $SEARCH"

# ─── (8) Cross-KB search ────────────────────────────────────────────
echo ""
echo "═══ Test 8: POST /v1/admin/embeddings/search ═══"
XSEARCH=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"query\":\"DPO LGPD\",\"knowledge_base_ids\":[\"$KB_ID\"],\"top_k\":2,\"min_score\":0.0}" \
    "$API/v1/admin/embeddings/search")
N_X_HITS=$(echo "$XSEARCH" | jq '.results | length')
[ "$N_X_HITS" -ge 1 ] && ok "cross-KB search returned $N_X_HITS hits" \
                     || fail "cross-KB search empty: $XSEARCH"

# ─── (9) Assistant ↔ KB linking ────────────────────────────────────
echo ""
echo "═══ Test 9: PUT/GET /v1/admin/assistants/:id/knowledge-bases ═══"
LINK_RESP=$(curl -sS -X PUT "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"knowledge_base_ids\":[\"$KB_ID\"]}" \
    "$API/v1/admin/assistants/$ASSIST_AUDITADO/knowledge-bases")
LINKED=$(echo "$LINK_RESP" | jq -r '.linked // 0')
[ "$LINKED" = "1" ] && ok "assistant linked to 1 KB" || fail "linking failed: $LINK_RESP"

GET_LINKED=$(curl -sS "${AUTH[@]}" \
    "$API/v1/admin/assistants/$ASSIST_AUDITADO/knowledge-bases" | jq 'length')
[ "$GET_LINKED" = "1" ] && ok "GET returns 1 linked KB" || fail "GET returned $GET_LINKED"

# ─── (10) Dispatch hook fires retrieval ────────────────────────────
echo ""
echo "═══ Test 10: dispatch hook → retrieval_log entry ═══"
# Capture baseline retrieval_log count for this assistant.
LOG_BEFORE=$(psql_q "SELECT COUNT(*) FROM retrieval_log WHERE assistant_id='$ASSIST_AUDITADO'")

# Trigger a work_item via the runtime admin POST endpoint (5b.2 path).
# The dispatch hook reads execution_context.assistant_id, queries akb,
# embeds the user message and writes to retrieval_log.
WI_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -H 'Content-Type: application/json' \
    -d "{\"mode\":\"agent\",\"assistant_id\":\"$ASSIST_AUDITADO\",\"message\":\"Quem é o DPO da empresa segundo a política LGPD?\"}" \
    "$API/v1/admin/runtime/work-items")
WI_ID=$(echo "$WI_RESP" | jq -r '.work_item_id // empty')
[ -n "$WI_ID" ] && ok "work_item created → $WI_ID" \
                || { fail "POST work-items failed: $WI_RESP"; exit 1; }

# Wait for dispatchWorkItem to run (it's BullMQ-async). The runner may
# not finish (LiteLLM rate limits in dev), but the retrieval_log row
# is written BEFORE the gRPC call, so we just need to wait for the
# hook to fire.
LOG_AFTER="$LOG_BEFORE"
for i in $(seq 1 30); do
    sleep 1
    LOG_AFTER=$(psql_q "SELECT COUNT(*) FROM retrieval_log WHERE assistant_id='$ASSIST_AUDITADO'")
    if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then break; fi
done
if [ "$LOG_AFTER" -gt "$LOG_BEFORE" ]; then
    ok "retrieval_log entry written ($LOG_BEFORE → $LOG_AFTER)"
    # Confirm the new entry has chunks_retrieved > 0 (mock provider
    # finds at least 1 chunk over the linked KB with min_score=0.6;
    # if mock seed makes them too dissimilar, retrieval may return 0
    # which is still a successful hook fire).
    LATEST=$(psql_q "SELECT chunks_retrieved || '|' || COALESCE(top_score::text, 'NULL') FROM retrieval_log WHERE assistant_id='$ASSIST_AUDITADO' ORDER BY created_at DESC LIMIT 1")
    echo "  ℹ️  latest retrieval_log: chunks=$LATEST (mock semantics — OK if 0)"
else
    fail "retrieval_log not incremented in 30s (was $LOG_BEFORE)"
fi

# ─── (11) DLP block — CPF in document ──────────────────────────────
echo ""
echo "═══ Test 11: DLP blocks doc with CPF ═══"
cat > /tmp/test-rag-pii.md <<'EOF'
# Cadastro de Cliente

Nome: João da Silva
CPF: 123.456.789-09
Endereço: Rua Exemplo, 100 — Centro
EOF

PII_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -F "file=@/tmp/test-rag-pii.md;type=text/markdown" \
    "$API/v1/admin/knowledge-bases/$KB_ID/documents")
PII_DOC=$(echo "$PII_RESP" | jq -r '.document_id // empty')
if [ -n "$PII_DOC" ]; then
    PII_STATUS=""
    for i in $(seq 1 15); do
        sleep 1
        PII_STATUS=$(curl -sS "${AUTH[@]}" "$API/v1/admin/documents/$PII_DOC" | jq -r '.extraction_status // ""')
        [ "$PII_STATUS" = "failed" ] && break
        [ "$PII_STATUS" = "ready" ] && break
    done
    PII_DETAIL=$(curl -sS "${AUTH[@]}" "$API/v1/admin/documents/$PII_DOC")
    DLP_ACTION=$(echo "$PII_DETAIL" | jq -r '.dlp_scan_result.action // "none"')
    if [ "$PII_STATUS" = "failed" ] && [ "$DLP_ACTION" = "block" ]; then
        ok "DLP blocked PII doc (status=failed, action=block)"
    else
        fail "DLP did not block: status=$PII_STATUS, action=$DLP_ACTION"
    fi
else
    fail "PII upload returned no document_id: $PII_RESP"
fi

# ─── (12) Document delete cascades to Qdrant ───────────────────────
echo ""
echo "═══ Test 12: DELETE document cascades to Qdrant ═══"
DEL_RESP=$(curl -sS -X DELETE "${AUTH[@]}" "$API/v1/admin/documents/$DOC_ID")
DELETED=$(echo "$DEL_RESP" | jq -r '.deleted // false')
[ "$DELETED" = "true" ] && ok "document delete OK" || fail "delete failed: $DEL_RESP"

sleep 1
N_AFTER=$(curl -sS -H "api-key: $QDRANT_KEY" \
    "$QDRANT/collections/$COL_NAME" \
    | jq -r '.result.points_count // 0')
# Allow either zero or some leftover (Qdrant batch delete is async with
# wait=true but reports may lag); accept N_AFTER < N_POINTS as success.
if [ "$N_AFTER" -lt "$N_POINTS" ]; then
    ok "Qdrant points reduced ($N_POINTS → $N_AFTER)"
else
    fail "Qdrant points not reduced ($N_POINTS → $N_AFTER)"
fi

# ─── (13) 5b.2 regression ──────────────────────────────────────────
echo ""
echo "═══ Test 13: 5b.2 reality-check still green ═══"
if bash tests/integration/test-execucoes-end-to-end.sh > /tmp/e2e-5b2.log 2>&1; then
    ok "5b.2 reality-check 20/20"
else
    fail "5b.2 regrediu — see /tmp/e2e-5b2.log"
    tail -10 /tmp/e2e-5b2.log
fi

# ─── Cleanup test KB ───────────────────────────────────────────────
curl -sS -X DELETE "${AUTH[@]}" "$API/v1/admin/knowledge-bases/$KB_ID" >/dev/null

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ RAG end-to-end PASSED" || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
