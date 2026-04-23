-- Migration: 087_delegation_prefix_patterns.sql
-- FASE 13.5b.1 — UX hotfix
-- ---------------------------------------------------------------------------
-- Backfill the three runtime-prefix escape hatches into every
-- delegation-enabled assistant:
--     [OPENCLAUDE]   → openclaude runtime
--     [CLAUDE_CODE]  → claude_code_official runtime
--     [AIDER]        → aider runtime
--
-- Why this exists: 13.5b/3 shipped the Aider runtime but the seed only
-- wrote [OPENCLAUDE] into auto_delegate_patterns. As a result, users
-- typing "[AIDER] analise o repo" hit the non-delegation path — the
-- message fell through to the normal LLM round-trip, and any Aider-only
-- capability (git commits, repo_map) never executed. The three prefixes
-- are equal citizens; if delegation is enabled, all three must match.
--
-- Idempotent: uses `NOT ... LIKE '%<TOKEN>%'` guards so re-runs on a
-- DB that already has the patterns are no-ops. The JSONB array-append
-- (|| operator on jsonb) is the same shape used in scripts/seed.sql.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── [OPENCLAUDE] ────────────────────────────────────────────────────────────
-- Kept as an explicit step even though seed.sql also backfills it, so
-- a DB that was seeded before the idempotent guard in seed.sql still
-- converges to the right state after running migrations.
UPDATE assistants SET delegation_config = jsonb_set(
    delegation_config,
    '{auto_delegate_patterns}',
    COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)
        || '"\\[OPENCLAUDE\\]"'::jsonb
)
WHERE delegation_config->>'enabled' = 'true'
  AND NOT COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)::text LIKE '%OPENCLAUDE%';

-- ── [CLAUDE_CODE] ───────────────────────────────────────────────────────────
-- New in 13.5b.1. Routes delegated work to the Claude Code Official runner.
UPDATE assistants SET delegation_config = jsonb_set(
    delegation_config,
    '{auto_delegate_patterns}',
    COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)
        || '"\\[CLAUDE_CODE\\]"'::jsonb
)
WHERE delegation_config->>'enabled' = 'true'
  AND NOT COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)::text LIKE '%CLAUDE_CODE%';

-- ── [AIDER] ─────────────────────────────────────────────────────────────────
-- New in 13.5b.1. Routes delegated work to the Aider runner (git-native).
UPDATE assistants SET delegation_config = jsonb_set(
    delegation_config,
    '{auto_delegate_patterns}',
    COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)
        || '"\\[AIDER\\]"'::jsonb
)
WHERE delegation_config->>'enabled' = 'true'
  AND NOT COALESCE(delegation_config->'auto_delegate_patterns', '[]'::jsonb)::text LIKE '%AIDER%';

COMMIT;
