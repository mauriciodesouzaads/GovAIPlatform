-- ============================================================================
-- Migration 071 — DLP Rules Table
-- Configurable Data Loss Prevention rules per organization.
-- Each rule maps a detector (builtin, regex, keyword_list) to an action
-- (mask, block, alert) and can be scoped to specific assistants.
-- ============================================================================

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dlp_rules (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            VARCHAR(120) NOT NULL,
    detector_type   VARCHAR(20)  NOT NULL CHECK (detector_type IN ('builtin', 'regex', 'keyword_list')),
    -- For builtin: entity name (CPF, EMAIL, PHONE, PERSON, CREDIT_CARD, etc.)
    -- For regex: the pattern string
    -- For keyword_list: NULL (keywords stored in pattern_config)
    pattern         TEXT,
    -- JSONB bag for extra config:
    --   keyword_list rules: { "keywords": ["palavra1", "palavra2", ...] }
    --   regex rules:        { "flags": "gi" }
    --   builtin rules:      {}
    pattern_config  JSONB        NOT NULL DEFAULT '{}',
    action          VARCHAR(10)  NOT NULL CHECK (action IN ('mask', 'block', 'alert')) DEFAULT 'mask',
    -- Empty array = applies to all assistants in org; non-empty = specific assistants
    applies_to      JSONB        NOT NULL DEFAULT '[]',
    is_active       BOOLEAN      NOT NULL DEFAULT true,
    -- System rules (seeded) cannot have name/detector_type/pattern changed
    is_system       BOOLEAN      NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS dlp_rules_org_active_idx
    ON dlp_rules (org_id, is_active)
    WHERE is_active = true;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE dlp_rules ENABLE ROW LEVEL SECURITY;

-- govai_app: full access scoped to current org
CREATE POLICY dlp_rules_tenant_isolation ON dlp_rules
    USING (org_id = current_setting('app.current_org_id', true)::uuid);

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON dlp_rules TO govai_app;

-- ── Trigger: updated_at ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_dlp_rules_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dlp_rules_updated_at ON dlp_rules;
CREATE TRIGGER dlp_rules_updated_at
    BEFORE UPDATE ON dlp_rules
    FOR EACH ROW EXECUTE FUNCTION set_dlp_rules_updated_at();
