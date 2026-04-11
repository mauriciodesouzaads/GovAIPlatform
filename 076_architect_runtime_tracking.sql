-- ============================================================================
-- 076_architect_runtime_tracking.sql
-- ----------------------------------------------------------------------------
-- FASE 5-hardening — runtime tracking columns + awaiting_approval status
--
-- Adds bookkeeping columns the OpenClaude adapter writes for every gRPC
-- event, plus a new 'awaiting_approval' status used while a tool call is
-- waiting for human decision.
-- ============================================================================

BEGIN;

-- ── Tracking columns ─────────────────────────────────────────────────────────
ALTER TABLE architect_work_items
    ADD COLUMN IF NOT EXISTS worker_runtime TEXT NOT NULL DEFAULT 'internal',
    ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;

COMMENT ON COLUMN architect_work_items.worker_runtime IS
    'Runtime that executed this work item: internal | openclaude | agno';
COMMENT ON COLUMN architect_work_items.last_event_at IS
    'Timestamp of last gRPC event received from the worker (touch on every emit)';
COMMENT ON COLUMN architect_work_items.cancellation_requested_at IS
    'When the user requested cancel; cancelled_at is only set after the worker confirms';

-- ── Add awaiting_approval to status CHECK ───────────────────────────────────
-- DROP existing CHECK constraint and recreate with the new state.
ALTER TABLE architect_work_items
    DROP CONSTRAINT IF EXISTS architect_work_items_status_check;

ALTER TABLE architect_work_items
    ADD CONSTRAINT architect_work_items_status_check
    CHECK (status = ANY (ARRAY[
        'pending'::text,
        'in_progress'::text,
        'awaiting_approval'::text,
        'done'::text,
        'blocked'::text,
        'cancelled'::text
    ]));

-- ── Index for fast scans of in-flight runs ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_work_items_active_runs
    ON architect_work_items (status, last_event_at)
    WHERE status IN ('in_progress', 'awaiting_approval');

CREATE INDEX IF NOT EXISTS idx_work_items_cancellation_pending
    ON architect_work_items (cancellation_requested_at)
    WHERE cancellation_requested_at IS NOT NULL AND status NOT IN ('cancelled', 'done', 'blocked');

COMMIT;
