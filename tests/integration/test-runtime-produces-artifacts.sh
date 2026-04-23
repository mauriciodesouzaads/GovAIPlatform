#!/usr/bin/env bash
# ============================================================================
# Reality-Check Harness — FASE 13.5a3
# ----------------------------------------------------------------------------
# Prova que OpenClaude executa tools de verdade, sem depender do texto
# final do LLM (que pode estar vazio por timeout de Cerebras — conhecido,
# fixado em 13.5b).
#
# A prova é a seguinte cadeia:
#   1. Enfileira [OPENCLAUDE] instruindo Write(<UNIQUE_MARKER>) +
#      Bash(cat) — marcador random para que o LLM não possa inventar.
#   2. Poll DB até status terminal.
#   3. Ler architect_work_item_events: deve existir
#      TOOL_START Write + TOOL_RESULT Write com
#      `output: "File created successfully at: <abs_path>"`.
#   4. Extrair <abs_path> do payload e conferir que o arquivo **existe
#      de verdade** dentro do volume do runner (`docker exec cat`).
#   5. Conferir que o **conteúdo** do arquivo bate com UNIQUE_MARKER —
#      LLM não pode forjar bytes no filesystem.
#   6. Se fullText do work_item estiver populado, conferir que contém o
#      marker (bonus). Se estiver vazio, apenas avisar — é a pendência
#      de 13.5b (Cerebras multi-turn timeout), não falha desta fase.
#
# Se Steps 3–5 passam, está provado: tool real invocado, disco real
# escrito, conteúdo real. Não há como falsear via LLM.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
# Default to the seeded "Assistente Jurídico" — the only demo assistant
# with delegation_config.enabled=true + the [OPENCLAUDE] regex pattern.
ASSISTANT_ID="${ASSISTANT_ID:-00000000-0000-0000-0002-000000000001}"
DEMO_API_KEY="${DEMO_API_KEY:-sk-govai-demo00000000000000000000}"
MAX_POLLS="${MAX_POLLS:-200}"        # 200 * 3s = 10 min (tool-heavy runs demoram)
POLL_INTERVAL="${POLL_INTERVAL:-3}"

UNIQUE_MARKER="REALITY_CHECK_$(date +%s)_$(head -c 4 /dev/urandom | xxd -p)"
FILENAME="reality-check-${UNIQUE_MARKER}.txt"

echo "═══ Setup ═══"
echo "  Marker:   ${UNIQUE_MARKER}"
echo "  Filename: ${FILENAME}"

echo ""
echo "═══ Step 1: Trigger delegation with explicit Write tool ═══"
PROMPT="[OPENCLAUDE] Use a ferramenta Write para criar um arquivo chamado ${FILENAME} no diretório de trabalho atual com exatamente este conteúdo: ${UNIQUE_MARKER}

Depois de criar, use a ferramenta Bash com pwd para mostrar o diretório atual, e depois Bash com cat no path absoluto que o Write retornou para confirmar que o arquivo está lá.

Se alguma das ferramentas falhar, pare e reporte o erro. Não invente resultados."

EXEC=$(curl -sS -X POST "$API/v1/execute/$ASSISTANT_ID" \
    -H "Authorization: Bearer $DEMO_API_KEY" \
    -H "x-org-id: $ORG" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg msg "$PROMPT" '{message: $msg}')")

WORK_ITEM=$(echo "$EXEC" | jq -r '._govai.workItemId // .workItemId // empty')
if [ -z "$WORK_ITEM" ] || [ "$WORK_ITEM" = "null" ]; then
    echo "❌ Delegation did not trigger — no workItemId in response:"
    echo "$EXEC" | head -c 500
    exit 1
fi
echo "  work_item_id: $WORK_ITEM"

echo ""
echo "═══ Step 2: Poll until terminal (max $((MAX_POLLS * POLL_INTERVAL))s) ═══"
STATUS=""
for i in $(seq 1 "$MAX_POLLS"); do
    sleep "$POLL_INTERVAL"
    STATUS=$(docker compose exec -T database psql -U postgres -d govai_platform -tAc \
        "SELECT status FROM architect_work_items WHERE id = '$WORK_ITEM'" \
        | tr -d '[:space:]')
    printf "  poll #%d: status=%s\n" "$i" "$STATUS"
    case "$STATUS" in
        done) echo "  ✓ terminal: done"; break ;;
        blocked|cancelled|failed)
            echo "❌ Terminal non-success: $STATUS"
            exit 1
            ;;
    esac
done
if [ "$STATUS" != "done" ]; then
    echo "❌ Timeout — status still '$STATUS' after $((MAX_POLLS * POLL_INTERVAL))s"
    exit 1
fi

echo ""
echo "═══ Step 3: Verify TOOL_START Write + TOOL_RESULT Write events ═══"
WRITE_EVENTS=$(docker compose exec -T database psql -U postgres -d govai_platform -tAc \
    "SELECT COUNT(*) FROM architect_work_item_events
     WHERE work_item_id = '$WORK_ITEM'
       AND tool_name = 'Write'
       AND event_type IN ('TOOL_START','TOOL_RESULT')" \
    | tr -d '[:space:]')
if [ "$WRITE_EVENTS" -lt 2 ]; then
    echo "❌ Expected >=2 Write events (TOOL_START + TOOL_RESULT), got $WRITE_EVENTS"
    echo "  Tools may not have been invoked at all."
    exit 1
fi
echo "  ✓ $WRITE_EVENTS Write events recorded (TOOL_START + TOOL_RESULT)"

echo ""
echo "═══ Step 4: Extract file path from TOOL_RESULT Write + verify on disk ═══"
WRITE_OUTPUT=$(docker compose exec -T database psql -U postgres -d govai_platform -tAc \
    "SELECT payload->>'output' FROM architect_work_item_events
     WHERE work_item_id = '$WORK_ITEM'
       AND tool_name = 'Write'
       AND event_type = 'TOOL_RESULT'
     ORDER BY event_seq DESC LIMIT 1")

if [ -z "$WRITE_OUTPUT" ] || [ "$WRITE_OUTPUT" = "null" ]; then
    echo "❌ TOOL_RESULT for Write has no output payload"
    exit 1
fi
echo "  Write TOOL_RESULT output:"
echo "$WRITE_OUTPUT" | head -c 300 | sed 's/^/    /'
echo ""

# Expected shape: "File created successfully at: /tmp/govai-workspaces/<org>/<session>/<file>"
FILE_ABS_PATH=$(echo "$WRITE_OUTPUT" \
    | grep -oE '/tmp/govai-workspaces?/[^[:space:]"]*' \
    | head -1)
if [ -z "$FILE_ABS_PATH" ]; then
    echo "❌ could not parse absolute path from TOOL_RESULT output"
    exit 1
fi
echo "  File absolute path: $FILE_ABS_PATH"

echo "  Checking openclaude-runner filesystem for the file…"
ON_DISK=$(docker compose exec -T openclaude-runner sh -c \
    "test -f '$FILE_ABS_PATH' && echo EXISTS || echo MISSING" 2>/dev/null | tr -d '[:space:]')
if [ "$ON_DISK" = "EXISTS" ]; then
    echo "  ✓ file exists in runner volume: $FILE_ABS_PATH"
else
    echo "  ⚠️  file not found on runner ($ON_DISK). Trying api container (shared volume)…"
    ON_DISK_API=$(docker compose exec -T api sh -c \
        "test -f '$FILE_ABS_PATH' && echo EXISTS || echo MISSING" 2>/dev/null | tr -d '[:space:]')
    if [ "$ON_DISK_API" = "EXISTS" ]; then
        echo "  ✓ file exists in api container (same volume): $FILE_ABS_PATH"
    else
        echo "❌ File NOT on disk anywhere. Write TOOL_RESULT claimed success but FS disagrees."
        exit 1
    fi
fi

echo ""
echo "═══ Step 5: Verify file content matches UNIQUE_MARKER ═══"
# Read via whichever container finds the file
FILE_CONTENT=$(docker compose exec -T openclaude-runner cat "$FILE_ABS_PATH" 2>/dev/null \
    || docker compose exec -T api cat "$FILE_ABS_PATH" 2>/dev/null \
    || echo "")
if echo "$FILE_CONTENT" | grep -q "$UNIQUE_MARKER"; then
    echo "  ✓ file content contains UNIQUE_MARKER: $UNIQUE_MARKER"
    echo "    real bytes on disk — cannot be hallucinated"
else
    echo "❌ file content does NOT contain UNIQUE_MARKER"
    echo "  Expected: $UNIQUE_MARKER"
    echo "  Got (first 200 chars):"
    echo "$FILE_CONTENT" | head -c 200 | sed 's/^/    /'
    exit 1
fi

echo ""
echo "═══ Step 6: Check fullText (informational — depends on final LLM turn) ═══"
FULLTEXT=$(docker compose exec -T database psql -U postgres -d govai_platform -tAc \
    "SELECT execution_context->>'fullText' FROM architect_work_items WHERE id = '$WORK_ITEM'")
if [ -z "$FULLTEXT" ] || [ "$FULLTEXT" = "null" ]; then
    echo "  ⚠️  fullText está vazio. Tools rodaram com sucesso, mas o turno final"
    echo "     do LLM não produziu texto (completionTokens=0). Conhecido: timeout"
    echo "     de Cerebras em cadeias multi-turn, deferido para 13.5b."
    echo "     NÃO reprova este teste — a execução real já foi provada nos steps 3-5."
else
    echo "  fullText length: ${#FULLTEXT}"
    if echo "$FULLTEXT" | grep -q "$UNIQUE_MARKER"; then
        echo "  ✓ bonus: fullText também contém o marker (cadeia completou sem timeout)"
    else
        echo "  ⚠️  bonus: fullText existe mas não contém o marker. Agent pode ter"
        echo "     parado de reportar. OK — steps 3-5 já provaram execução real."
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ REALITY CHECK PASSED"
echo "   work_item:       $WORK_ITEM"
echo "   marker:          $UNIQUE_MARKER"
echo "   file on disk:    $FILE_ABS_PATH"
echo "   content matches: yes"
echo "   Write events:    $WRITE_EVENTS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
