-- Migration: 053_shield_enterprise_hardening.sql
-- Sprint S3 — Shield Enterprise Hardening
--
-- INCREMENTAL: ADD COLUMN IF NOT EXISTS em todas as alterações.
-- NÃO quebra baseline existente (047–052).
--
-- 1. Health tracking em todos os collectors (success/failure/scheduling)
-- 2. Enriquecimento de shield_posture_snapshots com métricas de cobertura
-- 3. Índice de suporte a histórico de posture por tenant

BEGIN;

-- ── 1. shield_oauth_collectors — health tracking ───────────────────────────────
-- Colunas já existentes: id, org_id, provider, credentials_ref,
--   external_tenant_id, last_collected_at, collection_enabled,
--   last_error, last_error_at, created_at

ALTER TABLE shield_oauth_collectors
    ADD COLUMN IF NOT EXISTS success_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_run_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS health_status   TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('healthy','degraded','error','unknown'));

-- ── 2. shield_google_collectors — health tracking ─────────────────────────────
-- Colunas já existentes: id, org_id, collector_name, admin_email_hash,
--   scopes, status, last_collected_at, last_error, last_error_at,
--   created_at, updated_at

ALTER TABLE shield_google_collectors
    ADD COLUMN IF NOT EXISTS success_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_run_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS health_status   TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('healthy','degraded','error','unknown'));

-- ── 3. shield_network_collectors — health tracking ────────────────────────────
-- Colunas já existentes: id, org_id, collector_name, source_kind,
--   status, last_sync_at, last_error, created_at, updated_at

ALTER TABLE shield_network_collectors
    ADD COLUMN IF NOT EXISTS success_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_count   INTEGER     NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_run_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS health_status   TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (health_status IN ('healthy','degraded','error','unknown'));

-- ── 4. shield_posture_snapshots — coverage metrics ────────────────────────────
-- Colunas já existentes: id, org_id, generated_at, posture, summary_score,
--   open_findings, promoted_findings, accepted_risk, top_tools,
--   recommendations, unresolved_critical

ALTER TABLE shield_posture_snapshots
    ADD COLUMN IF NOT EXISTS sanctioned_count   INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unsanctioned_count INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_tools        INTEGER       NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS coverage_ratio     NUMERIC(5,2); -- governed/detected, NULL if no tools

-- ── 5. Índice de suporte a histórico de posture por tenant ────────────────────
CREATE INDEX IF NOT EXISTS idx_shield_posture_snapshots_org_generated
    ON shield_posture_snapshots(org_id, generated_at DESC);

COMMIT;
