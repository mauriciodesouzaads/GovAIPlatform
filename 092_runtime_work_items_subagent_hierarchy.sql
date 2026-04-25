-- Migration 092 — FASE 14.0/3b · Feature 2
-- =====================================================================
-- Subagent hierarchy on runtime_work_items.
--
-- The Claude Code CLI's Task tool dispatches a sub-agent (e.g. an
-- "Explore" or "general-purpose" agent type) within the same run.
-- Each Task invocation gets its own conversation; from the api's
-- audit perspective we want a child runtime_work_item per subagent
-- so the timeline preserves the cause/effect chain.
--
-- The subagent is NOT redispatched via BullMQ — execution still
-- happens inside the parent CLI process; we only persist the
-- spawn fact + the subagent's final result. parent_work_item_id
-- + subagent_depth let the UI render trees efficiently.
-- =====================================================================

BEGIN;

ALTER TABLE runtime_work_items
    ADD COLUMN IF NOT EXISTS parent_work_item_id UUID
        REFERENCES runtime_work_items(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS subagent_depth INT NOT NULL DEFAULT 0
        CHECK (subagent_depth >= 0 AND subagent_depth <= 5);

CREATE INDEX IF NOT EXISTS idx_runtime_work_items_parent
    ON runtime_work_items (parent_work_item_id)
    WHERE parent_work_item_id IS NOT NULL;

COMMENT ON COLUMN runtime_work_items.parent_work_item_id IS
    'FASE 14.0/3b: when this work_item is a subagent spawned via the '
    'CLI Task tool, points at the parent runtime_work_item that issued '
    'the Task call. NULL for top-level work_items.';
COMMENT ON COLUMN runtime_work_items.subagent_depth IS
    'FASE 14.0/3b: 0 for top-level, parent.depth + 1 for nested. '
    'Capped at 5 to prevent runaway recursion (the CLI itself caps '
    'at 4-5 levels; this is a defense-in-depth backstop).';

COMMIT;
