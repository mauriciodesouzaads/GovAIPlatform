-- Migration 090 — FASE 14.0/3a
-- =====================================================================
-- Add session_id to runtime_work_items so the api can correlate a work
-- item with the underlying runner session it ran in. Today only
-- claude-code-runner populates this (CLI's --session-id / --resume);
-- openclaude-runner and aider-runner leave it NULL.
--
-- Index lets the admin UI ("recent sessions" widget, Etapa 5) join the
-- Redis runtime:sessions:<org_id> hash with the actual work_item rows.
-- =====================================================================

BEGIN;

ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS session_id UUID;

COMMENT ON COLUMN runtime_work_items.session_id IS
    'FASE 14.0/3a: opaque ID of the runtime session this work item ran in. '
    'For claude_code_official this is the CLI --session-id (resumable via '
    'runtime_options.resume_session_id on the next request). NULL for '
    'runners that do not yet support sessions (openclaude, aider).';

-- Partial index: most rows have session_id NULL (openclaude/aider);
-- only the ones backed by claude-code-runner are interesting to query.
CREATE INDEX IF NOT EXISTS idx_runtime_work_items_session
    ON runtime_work_items (session_id)
    WHERE session_id IS NOT NULL;

COMMIT;
