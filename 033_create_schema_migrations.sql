-- Migration 033: Create schema_migrations tracking table
-- Provides an audit trail of which migrations have been applied to this database.
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Back-fill all previously applied migrations (011–032).
-- ON CONFLICT DO NOTHING ensures idempotency if this runs more than once.
INSERT INTO schema_migrations (filename)
SELECT unnest(ARRAY[
    '011_add_assistant_and_policy_versions.sql',
    '012_add_mcp_servers_and_grants.sql',
    '013_add_sso_and_federation.sql',
    '014_add_encrypted_runs.sql',
    '015_add_finops_billing.sql',
    '016_add_homologation_fields.sql',
    '017_add_password_and_roles_to_users.sql',
    '018_add_dek_to_encrypted_runs.sql',
    '019_rls_and_immutable_policies.sql',
    '020_expiration_worker_rls_bypass.sql',
    '021_fix_users_rls_for_login.sql',
    '022_grant_encrypted_runs.sql',
    '023_fix_partition_ownership.sql',
    '024_create_platform_admin_role.sql',
    '025_add_telemetry_consent.sql',
    '026_add_audit_compliance_indexes.sql',
    '027_add_key_rotation_tracking.sql',
    '028_create_user_lookup.sql',
    '029_expiration_worker_role_grant.sql',
    '030_extend_audit_action_constraint.sql',
    '031_add_api_key_revocation.sql',
    '032_explicit_vector_dimension.sql',
    '033_create_schema_migrations.sql'
])
ON CONFLICT DO NOTHING;
