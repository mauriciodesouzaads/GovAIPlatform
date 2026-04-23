-- Migration: 086_aider_runtime_profile.sql
-- FASE 13.5b/3 — register Aider as a governed runtime alongside OpenClaude
-- and Claude Code Official.
-- ---------------------------------------------------------------------------
-- The runtime selector in the chat UI reads from runtime_profiles and
-- shows whatever is `status='active'` with a configured transport. After
-- this migration, operators see three runtimes instead of two.
--
-- Idempotent via ON CONFLICT on the scope-aware unique index
-- (slug, COALESCE(org_id, '0000…')).
-- ---------------------------------------------------------------------------

BEGIN;

-- Global (org_id=NULL) profile entry. Idempotent via NOT EXISTS since
-- the unique index uses COALESCE(org_id, '0000…') and ON CONFLICT can't
-- reference expressions on nullable columns cleanly across Postgres
-- versions.
INSERT INTO runtime_profiles (
    slug,
    display_name,
    runtime_class,
    engine_vendor,
    engine_family,
    config,
    is_default
)
SELECT
    'aider',
    'Aider',
    -- runtime_class is CHECK-constrained to ('official','open','human','internal').
    -- Aider is an opensource CLI agent → 'open'.
    'open',
    'aider-ai',
    'aider',
    '{
        "socket_path_env": "AIDER_SOCKET_PATH",
        "grpc_host_env": "AIDER_GRPC_HOST",
        "container_service": "aider-runner",
        "claim_level": "open_governed",
        "capabilities": ["code_edit", "git_commit", "file_read", "file_write", "repo_map"],
        "approval": {"default": "auto", "destructive": "require_hitl"},
        "model_env": "AIDER_MODEL",
        "default_model": "govai-llm-cerebras"
    }'::jsonb,
    false
WHERE NOT EXISTS (
    SELECT 1 FROM runtime_profiles WHERE slug = 'aider' AND org_id IS NULL
);

-- Refresh config on repeat runs (idempotent update).
UPDATE runtime_profiles
   SET config = '{
        "socket_path_env": "AIDER_SOCKET_PATH",
        "grpc_host_env": "AIDER_GRPC_HOST",
        "container_service": "aider-runner",
        "claim_level": "open_governed",
        "capabilities": ["code_edit", "git_commit", "file_read", "file_write", "repo_map"],
        "approval": {"default": "auto", "destructive": "require_hitl"},
        "model_env": "AIDER_MODEL",
        "default_model": "govai-llm-cerebras"
    }'::jsonb,
       updated_at = NOW()
 WHERE slug = 'aider' AND org_id IS NULL;

COMMIT;
