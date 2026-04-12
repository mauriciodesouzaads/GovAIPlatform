-- ============================================================================
-- 079_runtime_scoped_bindings.sql
-- ----------------------------------------------------------------------------
-- FASE 8 — Scoped runtime bindings + claim persistence
--
-- Extends the FASE 7 runtime_profiles system with:
--   1. runtime_profile_bindings — per-scope (tenant, assistant, template, case)
--      binding table so resolution follows a 5-layer priority chain.
--   2. Scope columns on architect_workflow_templates and demand_cases.
--   3. runtime_claim_level on architect_work_items so every run records
--      its governance claim at dispatch time.
--   4. Seed: default tenant binding → openclaude for the demo org.
-- ============================================================================

BEGIN;

-- ─── 1. runtime_profile_bindings ────────────────────────────────────────────
-- Maps (org, scope_type, scope_id) → a runtime_profile_id. The resolver
-- reads this table at layers 2-5 of the priority chain. Each scope can
-- only have ONE active binding (enforced by the UNIQUE constraint).
CREATE TABLE IF NOT EXISTS runtime_profile_bindings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    scope_type          TEXT NOT NULL
                        CHECK (scope_type IN ('tenant', 'assistant', 'workflow_template', 'case')),
    scope_id            UUID NOT NULL,
    runtime_profile_id  UUID NOT NULL REFERENCES runtime_profiles(id) ON DELETE CASCADE,
    priority            INTEGER NOT NULL DEFAULT 100,
    created_by          UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_rpb_org_scope
    ON runtime_profile_bindings (org_id, scope_type, scope_id);

ALTER TABLE runtime_profile_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_profile_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_rpb ON runtime_profile_bindings;
CREATE POLICY org_isolation_rpb ON runtime_profile_bindings
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON runtime_profile_bindings TO govai_app;


-- ─── 2. architect_workflow_templates: runtime preference ────────────────────
ALTER TABLE architect_workflow_templates
    ADD COLUMN IF NOT EXISTS runtime_profile_id UUID REFERENCES runtime_profiles(id),
    ADD COLUMN IF NOT EXISTS runtime_selection_mode TEXT NOT NULL DEFAULT 'inherit'
        CHECK (runtime_selection_mode IN ('inherit', 'fixed', 'user_selectable'));


-- ─── 3. demand_cases: selected runtime for this case run ────────────────────
ALTER TABLE demand_cases
    ADD COLUMN IF NOT EXISTS selected_runtime_profile_id UUID REFERENCES runtime_profiles(id),
    ADD COLUMN IF NOT EXISTS runtime_selection_source TEXT
        CHECK (runtime_selection_source IN (
            'tenant_default', 'assistant_default', 'template_default',
            'user_selected', 'system_fallback'
        ));


-- ─── 4. architect_work_items: claim_level recorded at dispatch ──────────────
-- The claim_level is frozen at dispatch time so audit reports always reflect
-- the runtime that WAS used, even if the profile config changes later.
ALTER TABLE architect_work_items
    ADD COLUMN IF NOT EXISTS runtime_claim_level TEXT;


-- ─── 5. Seed: demo tenant default → openclaude ─────────────────────────────
-- The demo org and users are seeded by init.sql which runs AFTER migrations.
-- On a fresh database the org may not exist yet, so we guard with EXISTS.
-- On a DB that already has init.sql applied, this INSERT fires immediately.
-- Either way, ON CONFLICT makes it idempotent.
INSERT INTO runtime_profile_bindings (
    org_id, scope_type, scope_id, runtime_profile_id, created_by
)
SELECT
    o.id,
    'tenant',
    o.id,
    rp.id,
    COALESCE(
        (SELECT id FROM users WHERE org_id = o.id LIMIT 1),
        o.id  -- sentinel if no users exist yet
    )
FROM organizations o
CROSS JOIN runtime_profiles rp
WHERE o.id = '00000000-0000-0000-0000-000000000001'
  AND rp.slug = 'openclaude'
ON CONFLICT (org_id, scope_type, scope_id) DO NOTHING;

COMMIT;
