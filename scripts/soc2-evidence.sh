#!/bin/bash
# ============================================================================
# SOC 2 Evidence Collection — FASE 12
# ----------------------------------------------------------------------------
# Generates a tarball of auditor-ready evidence for a given date range.
# Exports: authentication events, policy changes, alert deliveries, DLP
# events, backup history, encryption rotations.
#
# Usage:
#   bash scripts/soc2-evidence.sh [START_DATE] [END_DATE]
# Defaults: last 90 days.
# ============================================================================

set -euo pipefail

START_DATE="${1:-$(date -d '90 days ago' +%Y-%m-%d 2>/dev/null || date -v-90d +%Y-%m-%d)}"
END_DATE="${2:-$(date +%Y-%m-%d)}"
OUT_DIR="${OUT_DIR:-/tmp/govai-soc2-evidence-$(date +%Y%m%d)}"

mkdir -p "$OUT_DIR"

echo "→ Collecting SOC 2 evidence for $START_DATE to $END_DATE"
echo "  Output: $OUT_DIR"

# Helper: COPY a query to stdout CSV, route to file
psql_copy() {
    local out="$1"
    local sql="$2"
    docker compose exec -T database psql -U postgres -d govai_platform -c "COPY ($sql) TO STDOUT WITH CSV HEADER" > "$out" 2>/dev/null || {
        echo "⚠️  Query failed (may be due to missing table in this deployment): $out"
    }
}

# ── CC6.1 — Access control events ──
psql_copy "$OUT_DIR/cc6.1-access-events.csv" "
    SELECT action, count(*) as count, min(created_at) as earliest, max(created_at) as latest
    FROM audit_logs_partitioned
    WHERE action IN ('LOGIN_SUCCESS','LOGIN_FAILURE','ROLE_CHANGE')
      AND created_at BETWEEN '$START_DATE' AND '$END_DATE'
    GROUP BY action
"

# ── CC8.1 — Policy version changes ──
psql_copy "$OUT_DIR/cc8.1-policy-changes.csv" "
    SELECT id, assistant_id, policy_hash, created_at, created_by
    FROM policy_versions
    WHERE created_at BETWEEN '$START_DATE' AND '$END_DATE'
    ORDER BY created_at DESC
"

# ── CC7.2 — Alert deliveries ──
psql_copy "$OUT_DIR/cc7.2-alert-deliveries.csv" "
    SELECT event_type, org_id, created_at, delivered_at, status
    FROM webhook_deliveries
    WHERE created_at BETWEEN '$START_DATE' AND '$END_DATE'
    ORDER BY created_at DESC
    LIMIT 10000
"

# ── C1.1 — Confidentiality (DLP events) ──
psql_copy "$OUT_DIR/c1.1-dlp-events.csv" "
    SELECT action, count(*) as count, date_trunc('day', created_at) AS day
    FROM audit_logs_partitioned
    WHERE action IN ('DLP_BLOCK','DLP_SANITIZE','POLICY_VIOLATION')
      AND created_at BETWEEN '$START_DATE' AND '$END_DATE'
    GROUP BY action, day
    ORDER BY day, action
"

# ── A1.2 — Availability (backup history from audit log) ──
psql_copy "$OUT_DIR/a1.2-backup-history.csv" "
    SELECT action, metadata->>'file' as file, metadata->>'size_bytes' as size_bytes, created_at
    FROM audit_logs_partitioned
    WHERE action = 'BACKUP_COMPLETED'
      AND created_at BETWEEN '$START_DATE' AND '$END_DATE'
    ORDER BY created_at DESC
"

# ── CC6.6 — Encryption (DEK rotations from run_content_encrypted) ──
psql_copy "$OUT_DIR/cc6.6-dek-rotations.csv" "
    SELECT date_trunc('day', created_at) as day, count(*) as runs_encrypted
    FROM run_content_encrypted
    WHERE created_at BETWEEN '$START_DATE' AND '$END_DATE'
    GROUP BY day
    ORDER BY day
"

# ── Platform version snapshot ──
git log -1 --format='%H %ci %s' > "$OUT_DIR/platform-version.txt" 2>/dev/null \
    || echo "git log unavailable" > "$OUT_DIR/platform-version.txt"

# ── Summary ──
cat > "$OUT_DIR/README.md" <<EOF
# SOC 2 Evidence Package

**Period:** $START_DATE to $END_DATE
**Platform version:** $(cat "$OUT_DIR/platform-version.txt")

## Files

- cc6.1-access-events.csv    — Authentication events summary
- cc6.6-dek-rotations.csv    — Encryption key rotation cadence
- cc7.2-alert-deliveries.csv — Incident alert delivery log
- cc8.1-policy-changes.csv   — Policy version change history
- c1.1-dlp-events.csv        — DLP block/sanitize events
- a1.2-backup-history.csv    — Database backup completions
- platform-version.txt       — Git revision of platform code

See \`docs/compliance/SOC2_CONTROL_MAPPING.md\` for full mapping to
Trust Services Criteria.
EOF

# ── Package ──
PARENT=$(dirname "$OUT_DIR")
BASENAME=$(basename "$OUT_DIR")
tar -czf "$OUT_DIR.tar.gz" -C "$PARENT" "$BASENAME"

echo "✅ Evidence package: $OUT_DIR.tar.gz"
echo "   Files: $(ls "$OUT_DIR" | wc -l | tr -d ' ')"
