-- ============================================================================
-- 074_catalog_skills_and_templates.sql
-- ----------------------------------------------------------------------------
-- FASE 5c — Skills Catalogáveis + Workflow Templates
--
-- Inspirado em:
--   - anthropics/skills (estrutura SKILL.md com instruções + recursos)
--   - claude-plugins-official/code-review (workflow paralelo + filtro confiança)
--   - claude-plugins-official/feature-dev (7 fases discovery → summary)
--
-- Cria três tabelas:
--   1. catalog_skills              — instruções reutilizáveis para o LLM
--   2. architect_workflow_templates — sequências de fases pré-definidas
--   3. assistant_skill_bindings    — vínculo skill ↔ assistente
-- ============================================================================

BEGIN;

-- ── 1. Skills Catalogáveis ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_skills (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name          VARCHAR(255) NOT NULL,
    description   TEXT,
    category      VARCHAR(100),                  -- analysis | generation | review | data | automation
    instructions  TEXT NOT NULL,                 -- markdown com instruções para o LLM
    resources     JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags          TEXT[] NOT NULL DEFAULT '{}',
    version       VARCHAR(50) NOT NULL DEFAULT '1.0',
    is_active     BOOLEAN NOT NULL DEFAULT true,
    is_system     BOOLEAN NOT NULL DEFAULT false,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_catalog_skills_org_active
    ON catalog_skills(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_catalog_skills_category
    ON catalog_skills(org_id, category) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_catalog_skills_tags
    ON catalog_skills USING gin(tags);

ALTER TABLE catalog_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_skills FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_catalog_skills ON catalog_skills;
CREATE POLICY org_isolation_catalog_skills ON catalog_skills
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_skills TO govai_app;

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_catalog_skills_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_skills_updated_at ON catalog_skills;
CREATE TRIGGER trg_catalog_skills_updated_at
    BEFORE UPDATE ON catalog_skills
    FOR EACH ROW EXECUTE FUNCTION update_catalog_skills_updated_at();


-- ── 2. Workflow Templates ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS architect_workflow_templates (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id                      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                        VARCHAR(255) NOT NULL,
    description                 TEXT,
    category                    VARCHAR(100),               -- development | review | analysis | security | compliance
    phases                      JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_execution_hint      VARCHAR(50) NOT NULL DEFAULT 'human',
    estimated_duration_minutes  INTEGER,
    is_active                   BOOLEAN NOT NULL DEFAULT true,
    is_system                   BOOLEAN NOT NULL DEFAULT false,
    created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, name),
    CONSTRAINT architect_workflow_templates_default_execution_hint_check
        CHECK (default_execution_hint IN ('mcp', 'agno', 'human', 'claude_code', 'internal_rag', 'openclaude'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_org_active
    ON architect_workflow_templates(org_id, is_active);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_category
    ON architect_workflow_templates(org_id, category) WHERE is_active = true;

ALTER TABLE architect_workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE architect_workflow_templates FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_workflow_templates ON architect_workflow_templates;
CREATE POLICY org_isolation_workflow_templates ON architect_workflow_templates
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON architect_workflow_templates TO govai_app;

CREATE OR REPLACE FUNCTION update_workflow_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_templates_updated_at ON architect_workflow_templates;
CREATE TRIGGER trg_workflow_templates_updated_at
    BEFORE UPDATE ON architect_workflow_templates
    FOR EACH ROW EXECUTE FUNCTION update_workflow_templates_updated_at();


-- ── 3. Assistant ↔ Skill Bindings ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assistant_skill_bindings (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id  UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    skill_id      UUID NOT NULL REFERENCES catalog_skills(id) ON DELETE CASCADE,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(assistant_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_assistant_skill_bindings_assistant
    ON assistant_skill_bindings(assistant_id, is_active);

ALTER TABLE assistant_skill_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_skill_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_skill_bindings ON assistant_skill_bindings;
CREATE POLICY org_isolation_skill_bindings ON assistant_skill_bindings
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_skill_bindings TO govai_app;

COMMIT;
