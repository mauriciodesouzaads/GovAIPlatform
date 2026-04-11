BEGIN;

-- ── Migration 073: OpenClaude adapter support ──────────────────────────────
-- Add 'openclaude' to execution_hint CHECK + runtime tracking columns

-- Current constraint (from migration 056 + 057):
-- CHECK (execution_hint IN ('mcp', 'agno', 'human', 'claude_code', 'internal_rag'))
ALTER TABLE architect_work_items
  DROP CONSTRAINT IF EXISTS architect_work_items_execution_hint_check;

ALTER TABLE architect_work_items
  ADD CONSTRAINT architect_work_items_execution_hint_check
  CHECK (execution_hint IN ('mcp', 'agno', 'human', 'claude_code', 'internal_rag', 'openclaude'));

-- Runtime tracking columns for OpenClaude worker correlation
ALTER TABLE architect_work_items
  ADD COLUMN IF NOT EXISTS worker_session_id TEXT,
  ADD COLUMN IF NOT EXISTS run_started_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ;

COMMENT ON COLUMN architect_work_items.worker_session_id IS
  'Session ID used in the OpenClaude gRPC stream for correlation';
COMMENT ON COLUMN architect_work_items.run_started_at IS
  'When the OpenClaude worker started executing this item';
COMMENT ON COLUMN architect_work_items.cancelled_at IS
  'When cancellation was requested/completed';

COMMIT;
