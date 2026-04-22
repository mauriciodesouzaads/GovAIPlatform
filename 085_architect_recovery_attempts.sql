-- Migration: 085_architect_recovery_attempts.sql
-- FASE 13.5a1 — watchdog recovery budget for orphaned PENDING work items.
-- ---------------------------------------------------------------------------
-- The TENANT_LIMIT orphan bug (fixed in the same hotfix) left a class of
-- work items stuck at status='pending' AND dispatch_attempts=0. The
-- watchdog now sweeps them and re-dispatches up to
-- ARCHITECT_MAX_RECOVERY_ATTEMPTS (default 3) times. After that it marks
-- the item as 'blocked' so it stops consuming queue cycles.
--
-- Column default 0 so existing rows join the eligible pool on first sweep.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE architect_work_items
    ADD COLUMN IF NOT EXISTS recovery_attempts SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'architect_work_items_recovery_attempts_check'
    ) THEN
        ALTER TABLE architect_work_items
            ADD CONSTRAINT architect_work_items_recovery_attempts_check
            CHECK (recovery_attempts >= 0);
    END IF;
END $$;

-- Partial index to speed up the watchdog sweep — only targets the
-- rows it actually scans.
CREATE INDEX IF NOT EXISTS idx_architect_work_items_orphan_sweep
    ON architect_work_items (created_at)
    WHERE status = 'pending' AND dispatch_attempts = 0;

COMMIT;
