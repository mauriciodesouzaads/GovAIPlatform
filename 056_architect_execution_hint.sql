BEGIN;

ALTER TABLE architect_work_items
  ADD COLUMN IF NOT EXISTS execution_hint TEXT
    CHECK (execution_hint IN (
      'mcp', 'agno', 'human', 'claude_code', 'internal_rag'
    ));

COMMENT ON COLUMN architect_work_items.execution_hint IS
  'Optional hint for the adapter layer: which executor should
handle this work item. NULL = human decision. Not enforced
by the control plane — advisory only.';

COMMIT;
