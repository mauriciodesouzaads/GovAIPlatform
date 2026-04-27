#!/usr/bin/env bash
# tests/integration/test-runner-workspace.sh
# ============================================================================
# Reality-check — FASE 14.0/6a₂.C (Container gordo + workspace + downloads)
# ----------------------------------------------------------------------------
# Verifies the four deliverables of 6a₂.C end-to-end:
#   1. CORS preflight stays 204 across the four endpoint families touched
#      since 6a₁ (kb / skills / skills+files / runtime-work-items+files).
#   2. claude-code-runner ships with python3, pip3, pandoc, wkhtmltopdf,
#      libreoffice — and the curated python libs (reportlab, openpyxl,
#      python-docx, pandas, matplotlib) import cleanly.
#   3. Mount points: /tmp/govai-workspaces RW (shared with api),
#      /mnt/skills RO (skills_storage volume).
#   4. captureWorkItemOutputs lifecycle: ad-hoc test fixture writes a
#      file into the workspace dir AS the `node` uid, simulating what a
#      Claude Code run would produce → captureWorkItemOutputs scans
#      and INSERTs into work_item_outputs → /files endpoint lists it →
#      /files/:fileId streams it back with Content-Disposition.
#
# We don't trigger a real Claude Code agent run (would burn budget +
# add minutes of latency). The hook itself is exercised by simulating
# the post-RUN_COMPLETED state directly: insert a runtime_work_items
# row with status=in_progress, drop a file in the workspace, then
# call the api endpoint to scan + serve. This proves the integration
# without a real Anthropic API call.
# ============================================================================

set -euo pipefail

API="${API:-http://localhost:3000}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
SANDBOX="${SANDBOX:-00000000-0000-0000-0fff-000000000004}"  # Coding Sandbox fixture

PASS=0; FAIL=0; TOTAL=0
ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $1"; }

psql_q() {
    docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc "$1"
}

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Runner gordo + workspace + downloads — 14.0/6a₂.C            "
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

# ─── Test 1: CORS preflight stays 204 cross-cutting ────────────────
echo ""
echo "═══ Test 1: CORS preflight on representative endpoints ═══"
SKILL_FIXTURE='00000000-0000-0000-0060-000000000001'  # Análise Jurídica (system)
WI_PROBE='00000000-0000-0000-0000-000000000000'        # placeholder uuid for OPTIONS
for entry in \
    "GET  /v1/admin/knowledge-bases" \
    "POST /v1/admin/catalog/skills/import-anthropic" \
    "GET  /v1/admin/catalog/skills/$SKILL_FIXTURE/files" \
    "GET  /v1/admin/runtime/work-items/$WI_PROBE/files" \
; do
    method="${entry%% *}"
    rest="${entry#* }"
    pth="${rest# *}"
    HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X OPTIONS "$API$pth" \
        -H 'Origin: http://localhost:3001' \
        -H "Access-Control-Request-Method: $method" \
        -H 'Access-Control-Request-Headers: authorization,content-type,x-org-id')
    [ "$HTTP" = "204" ] && ok "preflight $method $pth → 204" \
        || fail "preflight $method $pth → $HTTP"
done

# ─── Test 2: tooling on the runner ─────────────────────────────────
echo ""
echo "═══ Test 2: claude-code-runner gordo tooling ═══"
RUNNER='govaigrcplatform-claude-code-runner-1'
for bin in python3 pip3 pandoc wkhtmltopdf libreoffice; do
    if docker exec "$RUNNER" which "$bin" >/dev/null 2>&1; then
        ok "$bin available"
    else
        fail "$bin missing"
    fi
done

# Python libs importable as the runtime user. Module names diverge from
# pip package names: PyPDF2 ships under module `PyPDF2` (CamelCase), not
# pypdf2; python-docx imports as `docx`.
if docker exec "$RUNNER" python3 -c \
    "import reportlab, PyPDF2, openpyxl, docx, pandas, matplotlib; print('OK')" 2>&1 \
    | grep -qE "^OK$"; then
    ok "python libs (reportlab, PyPDF2, openpyxl, docx, pandas, matplotlib) importable"
else
    fail "python libs not importable"
fi

# ─── Test 3: mount points ──────────────────────────────────────────
echo ""
echo "═══ Test 3: workspaces (RW) + skills (RO) mounts ═══"
docker exec "$RUNNER" sh -c "test -d /tmp/govai-workspaces && test -d /mnt/skills" \
    && ok "/tmp/govai-workspaces and /mnt/skills exist" \
    || fail "mount dirs missing"

# Write probe — workspaces should be RW
if docker exec -u node "$RUNNER" sh -c \
    "touch /tmp/govai-workspaces/.test-write && rm /tmp/govai-workspaces/.test-write" \
    >/dev/null 2>&1; then
    ok "/tmp/govai-workspaces RW for node user"
else
    fail "/tmp/govai-workspaces not writable"
fi

# /mnt/skills should reject writes — Read-only file system error
RO_PROBE=$(docker exec -u node "$RUNNER" sh -c \
    "touch /mnt/skills/.should-fail 2>&1" 2>&1 || true)
if echo "$RO_PROBE" | grep -qiE "Read-only|permission denied"; then
    ok "/mnt/skills read-only (write rejected: $(echo "$RO_PROBE" | head -1))"
else
    fail "/mnt/skills NOT read-only — runner could mutate skills! probe=$RO_PROBE"
fi

# ─── Test 4: workspace shared between api and runner ───────────────
echo ""
echo "═══ Test 4: workspaces volume shared api ↔ runner ═══"
PROBE_FILE=".6a2c-shared-probe-$(date +%s)"
docker exec govaigrcplatform-api-1 sh -c "touch /tmp/govai-workspaces/$PROBE_FILE" 2>&1 \
    && ok "api wrote to shared volume"
docker exec "$RUNNER" sh -c "test -e /tmp/govai-workspaces/$PROBE_FILE" \
    && ok "runner sees same file → volume shared" \
    || fail "runner cannot see api's file → volume NOT shared"
docker exec govaigrcplatform-api-1 sh -c "rm /tmp/govai-workspaces/$PROBE_FILE" || true

# ─── Test 5: captureWorkItemOutputs end-to-end ─────────────────────
#
# Direct unit test of the capture+download pipeline without depending
# on a real agent run racing against cleanupWorkspace.
#
# Strategy:
#   1. INSERT a runtime_work_items row with status='done' (we won't
#      dispatch — we're testing the capture mechanism in isolation).
#   2. Create the workspace dir as the api user + plant a probe file.
#   3. Hit a one-shot endpoint that scans + persists. Since we don't
#      have a "rescan outputs" endpoint, we trigger by calling the
#      capture function via a small Node one-liner inside the api
#      container — exercises the same code path as RUN_COMPLETED
#      without the dispatch overhead.
#   4. Verify work_item_outputs row landed + /files endpoint lists +
#      /files/:fileId streams content back.
echo ""
echo "═══ Test 5: captureWorkItemOutputs end-to-end ═══"

# Generate a UUID for the staged work item.
WI=$(docker exec govaigrcplatform-database-1 psql -U postgres -d govai_platform -tAc \
    "SELECT uuid_generate_v4()")

# Stage a 'done' work_item for the SANDBOX assistant (agent mode requires
# a non-NULL assistant_id; SANDBOX is the published Coding Sandbox fixture).
psql_q "INSERT INTO runtime_work_items
            (id, org_id, node_id, item_type, title, description, status,
             execution_mode, assistant_id, runtime_profile_slug)
        VALUES ('$WI', '$ORG', 'rt-6a2c-test', 'compliance_check',
                '6a2c probe', '6a2c probe', 'done',
                'agent', '$SANDBOX', 'openclaude')" >/dev/null \
    && ok "staged work_item $WI status=done" \
    || fail "could not stage work_item"

# Create workspace dir + plant probe file as the api user (govai).
WS_PATH="/tmp/govai-workspaces/$ORG/$WI"
docker exec govaigrcplatform-api-1 sh -c \
    "mkdir -p $WS_PATH && echo 'Etapa 6a2C OK' > $WS_PATH/probe-output.txt && \
     echo 'auxiliar' > $WS_PATH/aux.txt" \
    && ok "workspace + probe + aux files written" \
    || fail "could not write probe files"

# Trigger captureWorkItemOutputs via a Node one-liner inside api.
# Imports the compiled module + the pgPool that the api itself uses,
# then runs the same function the RUN_COMPLETED handler calls.
CAPTURE_OUT=$(docker exec govaigrcplatform-api-1 node -e "
    (async () => {
        const { captureWorkItemOutputs } = require('/app/dist/lib/workspace-outputs');
        const { pgPool } = require('/app/dist/lib/db');
        const r = await captureWorkItemOutputs(pgPool, '$ORG', '$WI');
        console.log(JSON.stringify(r));
        await pgPool.end();
        process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
" 2>&1)
if echo "$CAPTURE_OUT" | grep -q '"captured":'; then
    ok "captureWorkItemOutputs invoked successfully ($(echo "$CAPTURE_OUT" | grep -o '"captured":[0-9]*'))"
else
    fail "captureWorkItemOutputs invocation failed: $(echo "$CAPTURE_OUT" | head -3)"
fi

N_OUT=$(psql_q "SELECT COUNT(*) FROM work_item_outputs WHERE work_item_id='$WI'")
[ "$N_OUT" -ge 2 ] \
    && ok "work_item_outputs has $N_OUT rows (probe + aux)" \
    || fail "expected ≥2 rows, got $N_OUT"

# /files endpoint lists the probe.
LIST=$(curl -sS "${AUTH[@]}" "$API/v1/admin/runtime/work-items/$WI/files")
PROBE_ID=$(echo "$LIST" | jq -r '.files[]? | select(.filename == "probe-output.txt") | .id' | head -1)
if [ -n "$PROBE_ID" ]; then
    ok "/files lists probe-output.txt → id=$PROBE_ID"

    # /files/:fileId stream download. The download endpoint must return
    # the persistent copy (NOT the workspace path) so it survives
    # cleanupWorkspace later.
    TMP_DL=$(mktemp)
    HTTP=$(curl -sS -o "$TMP_DL" -w "%{http_code}" "${AUTH[@]}" \
        "$API/v1/admin/runtime/work-items/$WI/files/$PROBE_ID")
    if [ "$HTTP" = "200" ]; then
        ok "/files/:fileId HTTP 200"
        grep -q "Etapa 6a2C OK" "$TMP_DL" \
            && ok "downloaded content matches probe" \
            || fail "content mismatch ($(head -c 60 "$TMP_DL"))"
    else
        fail "/files/:fileId HTTP $HTTP"
    fi
    rm -f "$TMP_DL"
else
    fail "probe-output.txt missing from /files response: $LIST"
fi

# Test the survival-after-cleanup invariant: blow away the workspace
# the way cleanupWorkspace would, then download again. Should still
# work because storage_path points at /var/govai/work-item-outputs.
docker exec govaigrcplatform-api-1 rm -rf "$WS_PATH" 2>/dev/null
if [ -n "$PROBE_ID" ]; then
    HTTP=$(curl -sS -o /dev/null -w "%{http_code}" "${AUTH[@]}" \
        "$API/v1/admin/runtime/work-items/$WI/files/$PROBE_ID")
    [ "$HTTP" = "200" ] \
        && ok "download still works after workspace cleanup (persistence confirmed)" \
        || fail "download failed after workspace removed: $HTTP"
fi

# Cleanup the staged row
psql_q "DELETE FROM runtime_work_items WHERE id='$WI'" >/dev/null

# ─── Test 6: regression ────────────────────────────────────────────
echo ""
echo "═══ Test 6: regression (6a₂.B + 6a₁ transitive) ═══"
if bash tests/integration/test-skills-hybrid.sh > /tmp/r6a2b.log 2>&1; then
    ok "test-skills-hybrid (6a₂.B) PASSED"
else
    fail "test-skills-hybrid regrediu — see /tmp/r6a2b.log (last 20 lines:)"
    tail -20 /tmp/r6a2b.log
fi

# ─── Summary ───────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Result: $PASS / $TOTAL pass, $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "  ✅ Runner gordo + workspace + downloads PASSED" \
                  || echo "  ❌ FAIL"
echo "════════════════════════════════════════════════════════════════"

[ "$FAIL" -eq 0 ]
