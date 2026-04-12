-- ============================================================================
-- 078_runtime_profiles.sql
-- ----------------------------------------------------------------------------
-- FASE 7 — Dual Governed Runtime (Official Claude Code + Open OpenClaude)
--
-- Background: until FASE 7, the only way to execute a delegated work item was
-- the OpenClaude runner. This migration introduces a polymorphic runtime
-- selection layer so the same governance pipeline (DLP, policy, audit,
-- approval bridge, workspace isolation, RLS) can route a work item to EITHER:
--
--   - Claude Code Official (runtime_class='official', claim_level=exact_governed):
--       the real Anthropic Claude Code CLI, run inside a sidecar container that
--       speaks the same openclaude.proto so the adapter code is unchanged.
--       Requires a valid ANTHROPIC_API_KEY in the runner's env. Available when
--       the sidecar is up, indisponível otherwise.
--
--   - OpenClaude (runtime_class='open', claim_level=open_governed):
--       the multi-provider open runtime we already ship. Uses LiteLLM to fan
--       out across Groq, Cerebras, Gemini, and Ollama with full failover.
--
-- This is NOT a rename or a rebranding — both runtimes coexist, the user picks
-- which engine to run, and GovAI governs everything regardless. The same
-- approve-all flow, the same audit trail, the same workspace isolation.
--
-- Scope of this migration:
--   1. runtime_profiles table (global + org-scoped rows, RLS-isolated)
--   2. runtime_switch_audit trail (every switch logged with actor + reason)
--   3. assistants.runtime_profile_slug + runtime_selection_mode (preference)
--   4. architect_work_items.runtime_profile_slug (which runtime this run used)
--   5. Seed 2 global profiles: claude_code_official + openclaude
-- ============================================================================

BEGIN;

-- ─── 1. runtime_profiles ────────────────────────────────────────────────────
-- Rows with org_id = NULL are global catalog entries visible to every tenant.
-- Tenant-specific overrides live with org_id = <tenant uuid> and shadow the
-- global row by slug. The unique index uses COALESCE to treat NULL org_id as
-- a fixed sentinel so (slug, org_id) uniqueness works for both cases.
CREATE TABLE IF NOT EXISTS runtime_profiles (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id           UUID REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global
    slug             TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    runtime_class    TEXT NOT NULL
                     CHECK (runtime_class IN ('official', 'open', 'human', 'internal')),
    engine_vendor    TEXT NOT NULL,
    engine_family    TEXT NOT NULL,
    -- config JSON shape (enforced in application, not SQL, to keep migration stable):
    --   {
    --     "capabilities":   {commands, agents, skills, hooks, mcp, tool_loop},
    --     "transport":      {mode: "grpc", proto: "openclaude.proto"},
    --     "security":       {requires_vault_secrets, requires_workspace_isolation},
    --     "approval":       {supported_modes: [...], default_mode: "auto_safe"},
    --     "claim_level":    "exact_governed" | "open_governed",
    --     "container_service": "claude-code-runner" | "openclaude-runner",
    --     "grpc_host_env":  "CLAUDE_CODE_GRPC_HOST" | "OPENCLAUDE_GRPC_HOST",
    --     "socket_path_env":"CLAUDE_CODE_SOCKET_PATH" | "OPENCLAUDE_SOCKET_PATH"
    --   }
    config           JSONB NOT NULL DEFAULT '{}'::jsonb,
    status           TEXT NOT NULL DEFAULT 'active',
    is_default       BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Uniqueness: one profile per (slug, org) scope. NULL org rows are treated as
-- a single shared global-scoped row via COALESCE to a sentinel zero UUID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_profiles_slug_scope
    ON runtime_profiles (
        slug,
        COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)
    );

CREATE INDEX IF NOT EXISTS idx_runtime_profiles_org_active
    ON runtime_profiles (org_id, status)
    WHERE status = 'active';

ALTER TABLE runtime_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rp_isolation ON runtime_profiles;
CREATE POLICY rp_isolation ON runtime_profiles
    FOR ALL TO govai_app
    USING (
        org_id IS NULL
        OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    )
    WITH CHECK (
        org_id IS NULL
        OR org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    );

GRANT SELECT, INSERT, UPDATE ON runtime_profiles TO govai_app;


-- ─── 2. runtime_switch_audit ────────────────────────────────────────────────
-- Immutable-append log of every runtime switch. The "actor who switched what
-- to what, when, and why" record. Queried by compliance/audit pages.
CREATE TABLE IF NOT EXISTS runtime_switch_audit (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id      UUID NOT NULL,
    scope_type         TEXT NOT NULL
                       CHECK (scope_type IN ('tenant', 'assistant', 'template', 'case', 'work_item')),
    scope_id           UUID NOT NULL,
    from_runtime_slug  TEXT,
    to_runtime_slug    TEXT NOT NULL,
    reason             TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rsa_org_created
    ON runtime_switch_audit (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rsa_scope
    ON runtime_switch_audit (scope_type, scope_id, created_at DESC);

ALTER TABLE runtime_switch_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_switch_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rsa_isolation ON runtime_switch_audit;
CREATE POLICY rsa_isolation ON runtime_switch_audit
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON runtime_switch_audit TO govai_app;


-- ─── 3. assistants runtime preference ───────────────────────────────────────
-- Default every existing assistant to 'openclaude' so the current behaviour
-- is preserved. runtime_selection_mode controls whether the user can override
-- the default in the chat UI:
--   - 'inherit'        → use whatever the tenant/session picks
--   - 'fixed'          → always this runtime, ignore user's pick
--   - 'user_selectable'→ the assistant has a preferred default but the user
--                        can switch to the other one on a per-turn basis
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS runtime_profile_slug TEXT DEFAULT 'openclaude';

ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS runtime_selection_mode TEXT NOT NULL DEFAULT 'user_selectable'
        CHECK (runtime_selection_mode IN ('inherit', 'fixed', 'user_selectable'));


-- ─── 4. architect_work_items: which runtime ran this item ───────────────────
-- Set by the adapter when it dispatches. Stays NULL for items that haven't
-- been routed to a runtime yet (human, internal_rag, agno). For openclaude
-- and claude_code_official the value matches the resolved runtime profile.
ALTER TABLE architect_work_items
    ADD COLUMN IF NOT EXISTS runtime_profile_slug TEXT;

CREATE INDEX IF NOT EXISTS idx_wi_runtime_profile
    ON architect_work_items (runtime_profile_slug)
    WHERE runtime_profile_slug IS NOT NULL;


-- ─── 5. Seed global catalog ─────────────────────────────────────────────────
-- Two fixed slugs the application pins against:
--
--   'claude_code_official' — routed to the claude-code-runner sidecar
--   'openclaude'           — routed to the openclaude-runner we already ship
--
-- Fixed UUIDs so unit tests and seed data can reference them directly.
-- ON CONFLICT is idempotent: re-running the migration is a no-op.
INSERT INTO runtime_profiles (
    id, org_id, slug, display_name, runtime_class,
    engine_vendor, engine_family, config, is_default
)
VALUES
(
    'a0000000-0000-0000-0000-000000000001',
    NULL,
    'claude_code_official',
    'Claude Code (Official)',
    'official',
    'anthropic',
    'claude_code',
    jsonb_build_object(
        'capabilities', jsonb_build_object(
            'commands', true, 'agents', true, 'skills', true,
            'hooks', true, 'mcp', true, 'tool_loop', true
        ),
        'transport', jsonb_build_object(
            'mode', 'grpc', 'proto', 'openclaude.proto'
        ),
        'security', jsonb_build_object(
            'requires_vault_secrets', true,
            'requires_workspace_isolation', true
        ),
        'approval', jsonb_build_object(
            'supported_modes', jsonb_build_array('auto_safe', 'single'),
            'default_mode', 'auto_safe'
        ),
        'claim_level',        'exact_governed',
        'container_service',  'claude-code-runner',
        'grpc_host_env',      'CLAUDE_CODE_GRPC_HOST',
        'socket_path_env',    'CLAUDE_CODE_SOCKET_PATH'
    ),
    false
),
(
    'a0000000-0000-0000-0000-000000000002',
    NULL,
    'openclaude',
    'OpenClaude (Open Runtime)',
    'open',
    'openclaude',
    'openclaude',
    jsonb_build_object(
        'capabilities', jsonb_build_object(
            'commands', false, 'agents', false, 'skills', true,
            'hooks', false, 'mcp', false, 'tool_loop', true
        ),
        'transport', jsonb_build_object(
            'mode', 'grpc', 'proto', 'openclaude.proto'
        ),
        'security', jsonb_build_object(
            'requires_vault_secrets', true,
            'requires_workspace_isolation', true
        ),
        'approval', jsonb_build_object(
            'supported_modes', jsonb_build_array('auto_all', 'auto_safe', 'single'),
            'default_mode', 'auto_safe'
        ),
        'claim_level',        'open_governed',
        'container_service',  'openclaude-runner',
        'grpc_host_env',      'OPENCLAUDE_GRPC_HOST',
        'socket_path_env',    'OPENCLAUDE_SOCKET_PATH'
    ),
    true  -- system default until an org overrides it
)
ON CONFLICT DO NOTHING;

COMMIT;
