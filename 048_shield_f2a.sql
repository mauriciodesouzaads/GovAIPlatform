-- Migration: 048_shield_f2a.sql
-- Objetivo: Shield F2a — Risk Engine + OAuth Collector + Executive Reports
--   Enriquecer shield_tools com metadados de risco.
--   Enriquecer shield_findings com risk_score / dimensions.
--   Criar shield_oauth_collectors, shield_oauth_grants, shield_executive_reports.
--
-- NOTA: A tabela de ferramentas é shield_tools (criada em 047).
--       Não criamos shield_tool_dictionary — enriquecemos o que existe.
--       user_identifier_hash = SHA-256 — NUNCA email plain.

BEGIN;

-- ── 1. Enriquecer shield_tools com metadados de risco ────────────────────────
ALTER TABLE shield_tools
    ADD COLUMN IF NOT EXISTS domains_json       jsonb    DEFAULT '[]',
    ADD COLUMN IF NOT EXISTS usage_modes        text[]   DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS data_exposure_risk integer  DEFAULT 5
        CHECK (data_exposure_risk BETWEEN 0 AND 20),
    ADD COLUMN IF NOT EXISTS vendor_risk        integer  DEFAULT 5
        CHECK (vendor_risk BETWEEN 0 AND 20);

-- Seed de ferramentas conhecidas (org-independente: linha base para novas orgs).
-- Usamos approval_status = 'blocked' para ferramentas shadow AI não sancionadas.
-- Estes UPDATEs só afetam linhas já existentes; o upsert de processShieldObservations
-- cria novas linhas por org_id quando ferramentas são detectadas.
UPDATE shield_tools SET
    domains_json       = '["chatgpt.com","chat.openai.com","openai.com"]'::jsonb,
    usage_modes        = '{web,api,saas_embedded}',
    data_exposure_risk = 14,
    vendor_risk        = 12
WHERE tool_name = 'ChatGPT';

UPDATE shield_tools SET
    domains_json       = '["claude.ai","anthropic.com"]'::jsonb,
    usage_modes        = '{web,api}',
    data_exposure_risk = 14,
    vendor_risk        = 10
WHERE tool_name = 'Claude';

UPDATE shield_tools SET
    domains_json       = '["gemini.google.com","bard.google.com"]'::jsonb,
    usage_modes        = '{web,api,saas_embedded}',
    data_exposure_risk = 16,
    vendor_risk        = 8
WHERE tool_name = 'Gemini';

UPDATE shield_tools SET
    domains_json       = '["github.com","copilot.github.com"]'::jsonb,
    usage_modes        = '{ide_plugin,api}',
    data_exposure_risk = 18,
    vendor_risk        = 7
WHERE tool_name = 'GitHub Copilot';

UPDATE shield_tools SET
    domains_json       = '["cursor.sh","cursor.com"]'::jsonb,
    usage_modes        = '{ide_plugin}',
    data_exposure_risk = 18,
    vendor_risk        = 11
WHERE tool_name = 'Cursor';

-- ── 2. Enriquecer shield_findings com risk score detalhado ───────────────────
ALTER TABLE shield_findings
    ADD COLUMN IF NOT EXISTS risk_score         integer DEFAULT 0
        CHECK (risk_score BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS risk_dimensions    jsonb   DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS confidence         integer DEFAULT 50
        CHECK (confidence BETWEEN 0 AND 100),
    ADD COLUMN IF NOT EXISTS recommendation     text,
    ADD COLUMN IF NOT EXISTS promotion_candidate boolean DEFAULT false;

-- ── 3. shield_oauth_collectors — configuração de coleta OAuth por org ─────────
CREATE TABLE IF NOT EXISTS shield_oauth_collectors (
    id                  uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider            varchar(50)  NOT NULL
        CHECK (provider IN ('microsoft', 'google')),
    credentials_ref     varchar(500),
    external_tenant_id  varchar(200),
    last_collected_at   timestamptz,
    collection_enabled  boolean      DEFAULT false,
    last_error          text,
    last_error_at       timestamptz,
    created_at          timestamptz  DEFAULT now(),
    UNIQUE(org_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_shield_oauth_collectors_org
    ON shield_oauth_collectors(org_id, collection_enabled);

ALTER TABLE shield_oauth_collectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_oauth_collectors FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_oauth_collector_iso ON shield_oauth_collectors
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON shield_oauth_collectors TO govai_app;

-- ── 4. shield_oauth_grants — grants OAuth coletados ──────────────────────────
-- user_identifier_hash = SHA-256(email ou principalId) — NUNCA email plain.
CREATE TABLE IF NOT EXISTS shield_oauth_grants (
    id                    uuid         DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id                uuid         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    collector_id          uuid         REFERENCES shield_oauth_collectors(id) ON DELETE SET NULL,
    provider              varchar(50)  NOT NULL,
    external_app_id       varchar(500),
    external_app_name     varchar(500),
    external_app_domain   varchar(200),
    user_identifier_hash  varchar(64)  NOT NULL, -- SHA-256, 64 chars hex
    scopes                text[]       DEFAULT '{}',
    grant_type            varchar(50),
    granted_at            timestamptz,
    raw_data              jsonb        DEFAULT '{}',
    created_at            timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_grants_org
    ON shield_oauth_grants(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shield_grants_domain
    ON shield_oauth_grants(external_app_domain, org_id);

ALTER TABLE shield_oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_oauth_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_grants_iso ON shield_oauth_grants
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON shield_oauth_grants TO govai_app;

-- ── 5. shield_executive_reports — relatórios executivos gerados ───────────────
CREATE TABLE IF NOT EXISTS shield_executive_reports (
    id            uuid   DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id        uuid   NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    period_start  date   NOT NULL,
    period_end    date   NOT NULL,
    summary_json  jsonb  DEFAULT '{}',
    generated_by  uuid   REFERENCES users(id) ON DELETE SET NULL,
    generated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shield_reports_org
    ON shield_executive_reports(org_id, generated_at DESC);

ALTER TABLE shield_executive_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_executive_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY shield_reports_iso ON shield_executive_reports
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON shield_executive_reports TO govai_app;

COMMIT;
