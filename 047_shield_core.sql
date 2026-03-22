-- Migration: 047_shield_core.sql
-- Objetivo: Shield Core / Detection Foundation
--   Domínio de observação de ferramentas AI shadow (shadow AI detection).
--   Esta migration entrega o núcleo de dados do Detection Plane:
--   dicionário de ferramentas, observações brutas, rollups e findings.
--   Collectors corporativos reais (M365, Google Workspace, DNS, browser
--   extension) ficam para sprints futuras — ver ADR-003.

BEGIN;

-- ── 1. shield_tools — dicionário de ferramentas detectadas ────────────────────
CREATE TABLE IF NOT EXISTS shield_tools (
    id                  UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id              UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    tool_name           TEXT        NOT NULL,
    tool_name_normalized TEXT       NOT NULL,
    vendor              TEXT,
    category            TEXT,
    risk_level          TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (risk_level IN ('unknown', 'low', 'medium', 'high', 'critical')),
    approval_status     TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (approval_status IN ('unknown', 'approved', 'restricted', 'blocked')),
    created_at          TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE (org_id, tool_name_normalized)
);

CREATE INDEX IF NOT EXISTS idx_shield_tools_org
    ON shield_tools(org_id, approval_status);

-- ── 2. shield_observations_raw — ingestão bruta de sinais ────────────────────
CREATE TABLE IF NOT EXISTS shield_observations_raw (
    id                      UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id                  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_type             TEXT        NOT NULL
        CHECK (source_type IN ('manual', 'oauth', 'network', 'browser', 'api')),
    tool_name               TEXT        NOT NULL,
    tool_name_normalized    TEXT        NOT NULL,
    user_identifier_hash    TEXT,        -- SHA-256 do identificador; nunca e-mail cru
    department_hint         TEXT,
    observed_at             TIMESTAMPTZ NOT NULL,
    raw_data                JSONB       NOT NULL DEFAULT '{}',
    processed               BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at              TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shield_obs_processing
    ON shield_observations_raw(org_id, processed, observed_at);
CREATE INDEX IF NOT EXISTS idx_shield_obs_tool
    ON shield_observations_raw(org_id, tool_name_normalized);

-- ── 3. shield_rollups — agregados diários por ferramenta ─────────────────────
-- ATENÇÃO: tool_id pode ser NULL se a ferramenta ainda não foi matcheada.
-- A coluna NÃO entra no UNIQUE pois nullable + UNIQUE gera comportamento
-- incorreto (NULL != NULL no índice).
CREATE TABLE IF NOT EXISTS shield_rollups (
    id                      UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id                  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    tool_name_normalized    TEXT        NOT NULL,
    tool_id                 UUID        REFERENCES shield_tools(id) ON DELETE SET NULL,
    period_start            TIMESTAMPTZ NOT NULL,
    period_end              TIMESTAMPTZ NOT NULL,
    observation_count       INTEGER     NOT NULL DEFAULT 0,
    unique_users            INTEGER     NOT NULL DEFAULT 0,
    last_seen_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now() NOT NULL,
    UNIQUE (org_id, tool_name_normalized, period_start)
);

CREATE INDEX IF NOT EXISTS idx_shield_rollups_org_period
    ON shield_rollups(org_id, period_start DESC);

-- ── 4. shield_findings — findings de uso shadow AI ───────────────────────────
CREATE TABLE IF NOT EXISTS shield_findings (
    id                      UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id                  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    tool_name               TEXT        NOT NULL,
    tool_name_normalized    TEXT        NOT NULL,
    tool_id                 UUID        REFERENCES shield_tools(id) ON DELETE SET NULL,
    severity                TEXT        NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status                  TEXT        NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'promoted', 'dismissed', 'resolved')),
    rationale               TEXT        NOT NULL,
    first_seen_at           TIMESTAMPTZ,
    last_seen_at            TIMESTAMPTZ,
    observation_count       INTEGER     NOT NULL DEFAULT 0,
    unique_users            INTEGER     NOT NULL DEFAULT 0,
    acknowledged_at         TIMESTAMPTZ,
    acknowledged_by         UUID        REFERENCES users(id) ON DELETE SET NULL,
    resolved_at             TIMESTAMPTZ,
    resolved_by             UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at              TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shield_findings_status
    ON shield_findings(org_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_shield_findings_tool
    ON shield_findings(org_id, tool_name_normalized);

-- Trigger updated_at automático em shield_findings
CREATE OR REPLACE FUNCTION update_shield_finding_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shield_findings_updated_at ON shield_findings;
CREATE TRIGGER trg_shield_findings_updated_at
    BEFORE UPDATE ON shield_findings
    FOR EACH ROW EXECUTE FUNCTION update_shield_finding_updated_at();

-- ── 5. RLS — isolamento por org_id ───────────────────────────────────────────
ALTER TABLE shield_tools             ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_tools             FORCE ROW LEVEL SECURITY;
ALTER TABLE shield_observations_raw  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_observations_raw  FORCE ROW LEVEL SECURITY;
ALTER TABLE shield_rollups           ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_rollups           FORCE ROW LEVEL SECURITY;
ALTER TABLE shield_findings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE shield_findings          FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shield_tools_isolation             ON shield_tools;
DROP POLICY IF EXISTS shield_observations_raw_isolation  ON shield_observations_raw;
DROP POLICY IF EXISTS shield_rollups_isolation           ON shield_rollups;
DROP POLICY IF EXISTS shield_findings_isolation          ON shield_findings;

CREATE POLICY shield_tools_isolation ON shield_tools
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY shield_observations_raw_isolation ON shield_observations_raw
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY shield_rollups_isolation ON shield_rollups
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY shield_findings_isolation ON shield_findings
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ── 6. Grants ─────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON shield_tools            TO govai_app;
GRANT SELECT, INSERT, UPDATE ON shield_observations_raw TO govai_app;
GRANT SELECT, INSERT, UPDATE ON shield_rollups          TO govai_app;
GRANT SELECT, INSERT, UPDATE ON shield_findings         TO govai_app;

COMMIT;
