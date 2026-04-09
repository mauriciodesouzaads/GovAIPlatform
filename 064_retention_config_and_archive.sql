-- Migration: 064_retention_config_and_archive.sql
-- Objetivo: Configuração de retenção por org + tabela de archive para audit logs

BEGIN;

-- ── Retention config ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_retention_config (
    org_id                   UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    audit_log_retention_days INTEGER      NOT NULL DEFAULT 365,
    archive_enabled          BOOLEAN      NOT NULL DEFAULT false,
    last_archive_run_at      TIMESTAMPTZ,
    last_archive_count       INTEGER      DEFAULT 0,
    updated_at               TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE org_retention_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation_retention ON org_retention_config;
CREATE POLICY org_isolation_retention ON org_retention_config
    FOR ALL TO govai_app
    USING  (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON org_retention_config TO govai_app;

-- ── Audit log archive ─────────────────────────────────────────────────────
-- Exact same columns as audit_logs_partitioned + archived_at
CREATE TABLE IF NOT EXISTS audit_logs_archive (
    id           UUID                     NOT NULL,
    org_id       UUID                     NOT NULL,
    assistant_id UUID,
    action       TEXT                     NOT NULL,
    metadata     JSONB,
    signature    TEXT                     NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE,
    trace_id     UUID,
    archived_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_org_date   ON audit_logs_archive (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_archive_archived   ON audit_logs_archive (archived_at);

-- No RLS on archive — access controlled by endpoint layer
GRANT SELECT, INSERT ON audit_logs_archive TO govai_app;

COMMIT;
