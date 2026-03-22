-- Migration: 049_shield_complete.sql
-- Objetivo: Shield Complete — finding workflow completo, Google collector,
--   posture snapshots, action log, enrichment de shield_tools.
--
-- INCREMENTAL: usa IF NOT EXISTS / IF EXISTS em todos os ALTER TABLE.
-- NÃO quebra modelagem existente.

BEGIN;

-- ── 1. Enriquecer shield_tools ────────────────────────────────────────────────
-- Colunas já existentes: id, org_id, tool_name, tool_name_normalized, vendor,
--   category, risk_level, approval_status, created_at, domains_json, usage_modes,
--   data_exposure_risk, vendor_risk
-- Adicionar apenas o que ainda não existe.

ALTER TABLE shield_tools
    ADD COLUMN IF NOT EXISTS aliases          jsonb      DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS sanctioned       boolean,
    ADD COLUMN IF NOT EXISTS risk_baseline    integer    DEFAULT 5
        CHECK (risk_baseline BETWEEN 0 AND 20),
    ADD COLUMN IF NOT EXISTS remediation_hint text,
    ADD COLUMN IF NOT EXISTS first_seen_at    timestamptz,
    ADD COLUMN IF NOT EXISTS last_seen_at     timestamptz;

-- ── 2. Enriquecer shield_findings ─────────────────────────────────────────────
-- Colunas já existentes: ..., resolved_at, resolved_by, risk_score,
--   risk_dimensions, confidence, recommendation, promotion_candidate

-- Ampliar CHECK de severity para incluir 'informational'
ALTER TABLE shield_findings
    DROP CONSTRAINT IF EXISTS shield_findings_severity_check;
ALTER TABLE shield_findings
    ADD CONSTRAINT shield_findings_severity_check
        CHECK (severity IN ('informational','low','medium','high','critical'));

-- Ampliar CHECK de status para incluir 'accepted_risk'
ALTER TABLE shield_findings
    DROP CONSTRAINT IF EXISTS shield_findings_status_check;
ALTER TABLE shield_findings
    ADD CONSTRAINT shield_findings_status_check
        CHECK (status IN ('open','acknowledged','promoted','accepted_risk','dismissed','resolved'));

-- Adicionar colunas de workflow e contexto
ALTER TABLE shield_findings
    ADD COLUMN IF NOT EXISTS accepted_risk          boolean     DEFAULT false,
    ADD COLUMN IF NOT EXISTS accepted_risk_note     text,
    ADD COLUMN IF NOT EXISTS accepted_risk_at       timestamptz,
    ADD COLUMN IF NOT EXISTS accepted_risk_by       uuid        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS dismissed_at           timestamptz,
    ADD COLUMN IF NOT EXISTS dismissed_by           uuid        REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS owner_candidate_hash   text,
    ADD COLUMN IF NOT EXISTS owner_candidate_source text,
    ADD COLUMN IF NOT EXISTS recommended_action     text,
    ADD COLUMN IF NOT EXISTS category               text,
    ADD COLUMN IF NOT EXISTS evidence_count         integer     DEFAULT 0;

-- ── 3. shield_google_collectors ───────────────────────────────────────────────
-- Configuração de coletor Google Workspace por org.
-- admin_email_hash = SHA-256(admin email) — nunca email plain.
CREATE TABLE IF NOT EXISTS shield_google_collectors (
    id                  uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    collector_name      text         NOT NULL,
    admin_email_hash    text,        -- SHA-256(admin email) para auditoria
    scopes              jsonb        NOT NULL DEFAULT '[]',
    status              text         NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','paused','error')),
    last_collected_at   timestamptz,
    last_error          text,
    last_error_at       timestamptz,
    created_at          timestamptz  DEFAULT now(),
    updated_at          timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_google_collectors_org
    ON shield_google_collectors(org_id, status);

ALTER TABLE shield_google_collectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_google_collectors FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_google_collectors_iso ON shield_google_collectors
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON shield_google_collectors TO govai_app;

-- ── 4. shield_google_tokens ───────────────────────────────────────────────────
-- Tokens OAuth Google armazenados criptografados.
-- access_token_encrypted e refresh_token_encrypted: nunca token puro.
-- token_hash: SHA-256 do access_token para deduplicação sem exposição.
CREATE TABLE IF NOT EXISTS shield_google_tokens (
    id                       uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    collector_id             uuid         NOT NULL
        REFERENCES shield_google_collectors(id) ON DELETE CASCADE,
    org_id                   uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    access_token_encrypted   text         NOT NULL,  -- nunca token puro fora deste campo
    refresh_token_encrypted  text,
    token_hash               text         NOT NULL,  -- SHA-256 para deduplicação
    expires_at               timestamptz,
    created_at               timestamptz  DEFAULT now(),
    updated_at               timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_google_tokens_org_expires
    ON shield_google_tokens(org_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_shield_google_tokens_collector
    ON shield_google_tokens(collector_id);

ALTER TABLE shield_google_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_google_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_google_tokens_iso ON shield_google_tokens
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON shield_google_tokens TO govai_app;

-- ── 5. shield_finding_actions ─────────────────────────────────────────────────
-- Log imutável de ações sobre findings.
-- action_type: acknowledge | promote | accept_risk | dismiss | resolve | reopen
CREATE TABLE IF NOT EXISTS shield_finding_actions (
    id            uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    finding_id    uuid         NOT NULL REFERENCES shield_findings(id) ON DELETE CASCADE,
    action_type   text         NOT NULL
        CHECK (action_type IN
            ('acknowledge','promote','accept_risk','dismiss','resolve','reopen')),
    actor_user_id uuid,
    note          text,
    created_at    timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_actions_finding
    ON shield_finding_actions(finding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shield_actions_org
    ON shield_finding_actions(org_id, created_at DESC);

ALTER TABLE shield_finding_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_finding_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_finding_actions_iso ON shield_finding_actions
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON shield_finding_actions TO govai_app;

-- ── 6. shield_posture_snapshots ───────────────────────────────────────────────
-- Snapshots persistidos de postura de risco por org.
-- Usado para tendências, relatórios consultivos e histórico executivo.
CREATE TABLE IF NOT EXISTS shield_posture_snapshots (
    id                  uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    generated_at        timestamptz  DEFAULT now(),
    posture             jsonb        NOT NULL DEFAULT '{}',
    summary_score       integer,
    open_findings       integer      DEFAULT 0,
    promoted_findings   integer      DEFAULT 0,
    accepted_risk       integer      DEFAULT 0,
    top_tools           jsonb        DEFAULT '[]',
    recommendations     jsonb        DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_shield_posture_org
    ON shield_posture_snapshots(org_id, generated_at DESC);

ALTER TABLE shield_posture_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_posture_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_posture_iso ON shield_posture_snapshots
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON shield_posture_snapshots TO govai_app;

COMMIT;
