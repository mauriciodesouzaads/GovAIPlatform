#!/usr/bin/env bash
# ============================================================================
# GovAI Platform — Sequential Migration Runner (Idempotent)
# ============================================================================
# Usage:
#   ./scripts/migrate.sh [DATABASE_URL]
#
# Aplica todas as migrations SQL em ordem contra o banco PostgreSQL alvo.
# Utiliza a tabela _migrations para rastrear quais já foram aplicadas —
# re-executar o script é seguro (idempotente).
#
# Migrations que contêm comandos privilegiados (CREATE POLICY, ALTER POLICY,
# ALTER ROLE, GRANT, SET ROLE) são executadas com credenciais de superuser.
# Configure POSTGRES_SUPERUSER_URL ou DB_PASSWORD no ambiente.
# ============================================================================

set -euo pipefail

DB_URL="${1:-${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/govai_platform}}"
DB_URL="${DB_URL%%\?schema=public*}"

echo "╔══════════════════════════════════════════════════╗"
echo "║     GovAI Platform — Database Migration          ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Mascara a senha na URL antes de exibir (evita vazamento em logs de CI/CD)
MASKED_URL=$(echo "$DB_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
echo "Target: $MASKED_URL"
echo ""

# ─── Superuser URL ───────────────────────────────────────────────────────────
# Usado para migrations que contêm CREATE POLICY, ALTER POLICY, ALTER ROLE,
# GRANT ou SET ROLE — operações que exigem ser owner da tabela ou superuser.
#
# Resolução em ordem de prioridade:
#   1. Variável POSTGRES_SUPERUSER_URL (ex: definida no docker-compose)
#   2. Substituição do user:pass em DB_URL pelo postgres + DB_PASSWORD
#   3. Fallback para DB_URL (pode falhar em migrations privilegiadas)
if [ -n "${POSTGRES_SUPERUSER_URL:-}" ]; then
    SU_URL="$POSTGRES_SUPERUSER_URL"
    MASKED_SU=$(echo "$SU_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
    echo "[MIGRATE] Superuser URL configurada: $MASKED_SU"
elif [ -n "${DB_PASSWORD:-}" ]; then
    SU_URL=$(echo "$DB_URL" | sed "s|://[^:]*:[^@]*@|://postgres:${DB_PASSWORD}@|")
    MASKED_SU=$(echo "$SU_URL" | sed 's|://[^:]*:[^@]*@|://***:***@|')
    echo "[MIGRATE] Superuser URL derivada de DB_PASSWORD: $MASKED_SU"
else
    SU_URL="$DB_URL"
    echo "[MIGRATE] WARNING: Sem credenciais de superuser — migrations privilegiadas podem falhar."
    echo "[MIGRATE] Defina POSTGRES_SUPERUSER_URL ou DB_PASSWORD para resolver."
fi
echo ""

# ─── Garantir tabela de tracking (como superuser para evitar problemas de permissão) ──
psql "$SU_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS _migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

# ─── Lista ordenada de migrations ─────────────────────────────────────────────
MIGRATIONS=(
    "011_add_assistant_and_policy_versions.sql"
    "012_add_mcp_servers_and_grants.sql"
    "013_add_sso_and_federation.sql"
    "014_add_encrypted_runs.sql"
    "015_add_finops_billing.sql"
    "016_add_homologation_fields.sql"
    "017_add_password_and_roles_to_users.sql"
    "018_add_dek_to_encrypted_runs.sql"
    "019_rls_and_immutable_policies.sql"
    "020_expiration_worker_rls_bypass.sql"
    "021_fix_users_rls_for_login.sql"
    "022_grant_encrypted_runs.sql"
    "023_fix_partition_ownership.sql"
    "024_create_platform_admin_role.sql"
    "025_add_telemetry_consent.sql"
    "026_add_audit_compliance_indexes.sql"
    "027_add_key_rotation_tracking.sql"
    "028_create_user_lookup.sql"
    "029_expiration_worker_role_grant.sql"
    "030_extend_audit_action_constraint.sql"
    "031_add_api_key_revocation.sql"
    "032_explicit_vector_dimension.sql"
    "033_create_schema_migrations.sql"
    "034_grant_platform_admin_table_access.sql"
    "035_organizations_rls.sql"
    "036_api_key_lookup_add_expires.sql"
    "037_documents_add_org_id.sql"
    "038_fix_version_publish_flow.sql"
    "039_identity_and_publish_hardening.sql"
    "040_org_sso_lookup.sql"
    "041_runtime_and_release_hardening.sql"
    "042_policy_snapshot_per_execution.sql"
    "043_policy_exceptions.sql"
    "044_evidence_domain.sql"
    "045_catalog_registry.sql"
    "046_consultant_plane.sql"
    "047_shield_core.sql"
    "048_shield_f2a.sql"
    "049_shield_complete.sql"
    "050_gap_marker.sql"
    "051_shield_multisource_resolution.sql"
    "052_shield_finding_workflow.sql"
    "053_shield_enterprise_hardening.sql"
    "054_hitl_timeout_per_org.sql"
    "055_architect_domain.sql"
    "056_architect_execution_hint.sql"
    "057_architect_work_item_execution.sql"
    "058_rls_nullif_remediation.sql"
    "059_exit_perimeter_tracking.sql"
    "060_risk_scoring_and_evidence.sql"
    "061_review_tracks_and_semver.sql"
    "062_catalog_favorites.sql"
    "063_review_tracks_customizable.sql"
    "064_retention_config_and_archive.sql"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUCCESS=0
SKIPPED=0
FAILED=0

for migration in "${MIGRATIONS[@]}"; do
    FILEPATH="$SCRIPT_DIR/$migration"

    if [ ! -f "$FILEPATH" ]; then
        echo "⚠️  SKIP: $migration (arquivo não encontrado)"
        continue
    fi

    # Verifica se já foi aplicada
    ALREADY_APPLIED=$(psql "$SU_URL" -tAq -c \
        "SELECT COUNT(*) FROM _migrations WHERE name = '$migration'" 2>/dev/null || echo "0")

    if [ "$ALREADY_APPLIED" = "1" ]; then
        echo "⏭  SKIP: $migration (já aplicada)"
        SKIPPED=$((SKIPPED+1))
        continue
    fi

    # Todas as migrations rodam como superuser para evitar problemas de ownership.
    # govai_app acessa as tabelas via GRANT statements dentro das próprias migrations.
    MIGRATION_URL="$SU_URL"
    echo -n "▶ Aplicando $migration... "

    # Executa a migration dentro de uma transação e registra na tabela de tracking
    if psql "$MIGRATION_URL" -v ON_ERROR_STOP=1 -q \
        -c "BEGIN;" \
        -f "$FILEPATH" \
        -c "INSERT INTO _migrations (name) VALUES ('$migration') ON CONFLICT DO NOTHING;" \
        -c "COMMIT;"; then
        echo "✅ OK"
        SUCCESS=$((SUCCESS+1))
    else
        echo "❌ FALHOU"
        FAILED=$((FAILED+1))
        echo ""
        echo "Erro ao aplicar $migration. Abortando."
        echo "Para depurar: psql \"$MASKED_URL\" -f \"$FILEPATH\""
        exit 1
    fi
done

echo ""
echo "════════════════════════════════════════════════════"
echo "  Aplicadas: $SUCCESS | Puladas: $SKIPPED | Falhas: $FAILED"
echo "════════════════════════════════════════════════════"

if [ "$FAILED" -eq 0 ]; then
    echo "✅ Todas as migrations finalizadas com sucesso."
else
    echo "❌ Algumas migrations falharam. Verifique os erros acima."
    exit 1
fi
