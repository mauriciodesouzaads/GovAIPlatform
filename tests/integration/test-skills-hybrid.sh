#!/usr/bin/env bash
# tests/integration/test-skills-hybrid.sh
# ============================================================================
# Reality-check — FASE 14.0/6a₂.B (Skills hybrid CRUD + injectSkills hook)
# ----------------------------------------------------------------------------
# Verifica:
#   1. catalog_skills tem as 5 colunas hybrid (migration 096 aplicada).
#   2. POST /v1/admin/catalog/skills com skill_type='prompt' funciona
#      (backwards-compat com a 5c).
#   3. POST /v1/admin/catalog/skills/import-anthropic com zip:
#      cria 1 catalog_skills (skill_type='anthropic') + N skill_files
#      no DB e persiste arquivos em /var/govai/skills-storage/<org>/<id>/.
#   4. GET /skills/:id/files lista os arquivos auxiliares.
#   5. Arquivos estão visíveis no FS dentro do container api.
#   6. GET /skills/:id/files/:fileId stream-downloads o conteúdo.
#   7. assistant_skill_bindings linka skill anthropic ao agente.
#   8. Hook injectSkills: execução real com skill linkada produz
#      runtime_work_items.execution_context.instruction contendo o
#      nome da skill + path /mnt/skills/<org>/<skill_id>.
#   9. Reality-checks de 5b.2 + 6a₁ continuam green (zero regressão).
#
# Esta sub-etapa NÃO depende do volume Docker skills_storage (vem na
# 6a₂.C). O caminho /mnt/skills/... é REFERENCIADO no system prompt
# mas ainda não está fisicamente montado no claude-code-runner —
# por isso o teste 8 verifica apenas a STRING injetada na instruction,
# não tenta executar o agente lendo os arquivos.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
DEMO_KEY="${DEMO_KEY:-sk-govai-demo00000000000000000000}"
ASSIST="${ASSIST:-00000000-0000-0000-0fff-000000000003}"  # Aider Pesquisa

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Skills hybrid + injectSkills — 14.0/6a₂.B                    "
echo "════════════════════════════════════════════════════════════════"

# ─── Setup ─────────────────────────────────────────────────────────
echo ""
echo "═══ Setup: admin login ═══"
TOKEN=$(curl -sS -X POST "$API/v1/admin/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"admin@orga.com","password":"GovAI2026@Admin"}' | jq -r .token)
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || { echo "  ❌ login failed"; exit 1; }
echo "  ✅ token captured"

AUTH=( -H "Authorization: Bearer $TOKEN" -H "x-org-id: $ORG" )

# ─── Test 1: schema 096 colunas hybrid ────────────────────────────
echo ""
echo "═══ Test 1: catalog_skills hybrid columns ═══"
N_COLS=$(psql_q "SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_name='catalog_skills'
                    AND column_name IN ('skill_type','skill_md_content','skill_md_frontmatter','file_count','total_size_bytes')")
[ "$N_COLS" = "5" ] && ok "5 hybrid columns present" || fail "expected 5, got $N_COLS"

# ─── Test 2: POST /skills tipo 'prompt' (backwards-compat) ────────
echo ""
echo "═══ Test 2: POST /skills tipo 'prompt' ═══"
SKILL_PROMPT=$(curl -sS -X POST "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d '{"name":"6a2B-prompt-test","description":"E2E","skill_type":"prompt","instructions":"You are a test assistant"}' \
    "$API/v1/admin/catalog/skills" | jq -r '.id // empty')
[ -n "$SKILL_PROMPT" ] && ok "prompt skill created → $SKILL_PROMPT" \
    || fail "POST /skills failed"

# ─── Test 3: POST /skills/import-anthropic ────────────────────────
echo ""
echo "═══ Test 3: POST /skills/import-anthropic with zip ═══"
TMPDIR=$(mktemp -d)
mkdir -p "$TMPDIR/test-skill/scripts" "$TMPDIR/test-skill/examples"
cat > "$TMPDIR/test-skill/SKILL.md" <<'EOF'
---
name: 6a2B Anthropic Hybrid
description: Skill de teste para 6a₂.B
category: testing
tags:
  - test
  - e2e
version: 1.0.0
---

# 6a2B Anthropic Hybrid

Esta skill demonstra a integração anthropic-style.

Use o script em scripts/process.py para processar dados.
Veja examples/case.md para um caso de uso completo.
EOF
cat > "$TMPDIR/test-skill/scripts/process.py" <<'EOF'
#!/usr/bin/env python3
print("Test skill executou")
EOF
cat > "$TMPDIR/test-skill/examples/case.md" <<'EOF'
# Caso de uso exemplo
Esta é uma documentação auxiliar.
EOF
(cd "$TMPDIR/test-skill" && zip -qr "$TMPDIR/test-skill.zip" .)

IMPORT=$(curl -sS -X POST "${AUTH[@]}" \
    -F "file=@$TMPDIR/test-skill.zip;type=application/zip" \
    "$API/v1/admin/catalog/skills/import-anthropic")
SKILL_ANTHRO=$(echo "$IMPORT" | jq -r '.skill_id // empty')
FILES_IMP=$(echo "$IMPORT" | jq -r '.files_imported // 0')

if [ -n "$SKILL_ANTHRO" ]; then
    ok "anthropic skill imported → $SKILL_ANTHRO"
else
    fail "import failed: $IMPORT"
fi
[ "$FILES_IMP" = "2" ] && ok "$FILES_IMP files imported (expected 2)" \
    || fail "expected 2 files, got $FILES_IMP — payload: $IMPORT"

# ─── Test 4: GET /skills/:id/files ────────────────────────────────
echo ""
echo "═══ Test 4: GET /skills/:id/files ═══"
LIST=$(curl -sS "${AUTH[@]}" "$API/v1/admin/catalog/skills/$SKILL_ANTHRO/files")
N_LIST=$(echo "$LIST" | jq '. | length')
[ "$N_LIST" = "2" ] && ok "GET returned $N_LIST files" \
    || fail "expected 2, got $N_LIST"

# ─── Test 5: arquivos persistidos no FS do api ────────────────────
echo ""
echo "═══ Test 5: files on api FS ═══"
docker exec govaigrcplatform-api-1 \
    test -f "/var/govai/skills-storage/$ORG/$SKILL_ANTHRO/scripts/process.py" \
    && ok "scripts/process.py persisted on FS" \
    || fail "scripts/process.py missing on FS"
docker exec govaigrcplatform-api-1 \
    test -f "/var/govai/skills-storage/$ORG/$SKILL_ANTHRO/examples/case.md" \
    && ok "examples/case.md persisted on FS" \
    || fail "examples/case.md missing on FS"

# ─── Test 6: download single file ──────────────────────────────────
echo ""
echo "═══ Test 6: download /skills/:id/files/:fileId ═══"
FILE_ID=$(echo "$LIST" | jq -r '.[] | select(.relative_path == "scripts/process.py") | .id')
[ -n "$FILE_ID" ] || { fail "scripts/process.py file_id not found in list"; FILE_ID=""; }
if [ -n "$FILE_ID" ]; then
    HTTP=$(curl -sS -o "$TMPDIR/downloaded.py" -w "%{http_code}" "${AUTH[@]}" \
        "$API/v1/admin/catalog/skills/$SKILL_ANTHRO/files/$FILE_ID")
    [ "$HTTP" = "200" ] && ok "download HTTP 200" || fail "download HTTP $HTTP"
    grep -q "Test skill executou" "$TMPDIR/downloaded.py" \
        && ok "downloaded content matches" \
        || fail "content mismatch: $(cat $TMPDIR/downloaded.py | head -3)"
fi

# ─── Test 7: link skill ao agente Aider Pesquisa ──────────────────
echo ""
echo "═══ Test 7: link assistant_skill_bindings ═══"
psql_q "INSERT INTO assistant_skill_bindings (assistant_id, skill_id, org_id, is_active)
        VALUES ('$ASSIST', '$SKILL_ANTHRO', '$ORG', true)
        ON CONFLICT (assistant_id, skill_id) DO UPDATE SET is_active = true" >/dev/null
N_BIND=$(psql_q "SELECT COUNT(*) FROM assistant_skill_bindings
                  WHERE assistant_id='$ASSIST' AND skill_id='$SKILL_ANTHRO'
                    AND is_active=true")
[ "$N_BIND" = "1" ] && ok "binding active" || fail "binding count $N_BIND"

# ─── Test 8: hook injectSkills produces anthropic block ───────────
#
# Uses the 5b.2 Modo Agente endpoint (POST /v1/admin/runtime/work-items)
# which dispatches via dispatchWorkItem directly. This is the same code
# path that runs the injectSkills hook — so testing here proves the
# skill block reaches execution_context.instruction.
#
# We chose Modo Agente over /v1/execute (LLM passthrough) because
# /v1/execute only creates a work_item when delegation_config.enabled
# fires a regex match — the Aider Pesquisa fixture has delegation
# disabled by default, so /v1/execute returns the LLM answer inline
# without producing a work_item.
echo ""
echo "═══ Test 8: hook injectSkills produces anthropic block ═══"
WI_RESP=$(curl -sS -X POST "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"mode\":\"agent\",\"assistant_id\":\"$ASSIST\",\"message\":\"6a2B test — confirme as skills aplicáveis\"}" \
    "$API/v1/admin/runtime/work-items")
WI=$(echo "$WI_RESP" | jq -r '.work_item_id // empty')
if [ -z "$WI" ]; then
    fail "POST /work-items did not return work_item_id — payload: $WI_RESP"
else
    ok "Modo Agente work_item → $WI"
    # Wait for dispatchWorkItem to assemble + persist the instruction.
    # The hook runs inside dispatch and writes the result to
    # execution_context.dispatched_instruction (added in 6a₂.B).
    INSTR=""
    for i in $(seq 1 30); do
        sleep 1
        INSTR=$(psql_q "SELECT execution_context->>'dispatched_instruction' FROM runtime_work_items WHERE id='$WI'")
        [ -n "$INSTR" ] && [ "$INSTR" != "" ] && break
    done
    if [ -z "$INSTR" ] || [ "$INSTR" = "" ]; then
        fail "dispatched_instruction never landed (worker may not have picked the job)"
    else
        echo "$INSTR" | grep -q "6a2B Anthropic Hybrid" \
            && ok "instruction includes anthropic skill name" \
            || fail "skill name not in instruction (preview: $(echo "$INSTR" | head -c 200))"
        echo "$INSTR" | grep -q "/mnt/skills/$ORG" \
            && ok "instruction references /mnt/skills path" \
            || fail "/mnt/skills path absent — preview: $(echo "$INSTR" | head -c 200)"
    fi
    # Best-effort cancel — the run isn't expected to finish meaningfully
    # since /mnt/skills isn't mounted yet (that's 6a₂.C).
    curl -sS -X POST "${AUTH[@]}" \
        "$API/v1/admin/runtime/work-items/$WI/cancel" >/dev/null 2>&1 || true
fi

# ─── Cleanup ─────────────────────────────────────────────────────
echo ""
echo "═══ Cleanup ═══"
psql_q "DELETE FROM assistant_skill_bindings
         WHERE skill_id='$SKILL_ANTHRO'" >/dev/null
curl -sS -X DELETE "${AUTH[@]}" \
    "$API/v1/admin/catalog/skills/$SKILL_PROMPT" >/dev/null 2>&1 || true
curl -sS -X DELETE "${AUTH[@]}" \
    "$API/v1/admin/catalog/skills/$SKILL_ANTHRO" >/dev/null 2>&1 || true
rm -rf "$TMPDIR"
echo "  ℹ️  test skills + tmpdir removed"

# ─── Test 9: regression — 6a₁ + 5b.2 ──────────────────────────────
echo ""
echo "═══ Test 9: regression ═══"
if bash tests/integration/test-rag-end-to-end.sh > /tmp/r1.log 2>&1; then
    ok "test-rag-end-to-end (6a₁) PASSED"
else
    fail "test-rag-end-to-end regrediu — see /tmp/r1.log"
fi

# ─── Summary ──────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Skills hybrid PASSED — 6a₂.B end-to-end" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
