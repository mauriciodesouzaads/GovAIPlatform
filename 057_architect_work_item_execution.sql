BEGIN;

ALTER TABLE architect_work_items
  ADD COLUMN IF NOT EXISTS dispatched_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatch_error     TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_attempts  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS execution_context  JSONB NOT NULL DEFAULT '{}';
  -- execution_context stores adapter-specific input/output:
  -- { input: {question, caseId}, output: {snippets}, adapter: 'internal_rag' }

COMMENT ON COLUMN architect_work_items.dispatched_at IS
  'When the delegation router last dispatched this work item.';
COMMENT ON COLUMN architect_work_items.dispatch_error IS
  'Last error from adapter execution, if any.';
COMMENT ON COLUMN architect_work_items.dispatch_attempts IS
  'Number of dispatch attempts. Max 3 before marking blocked.';
COMMENT ON COLUMN architect_work_items.execution_context IS
  'Adapter-specific input and output payload. Auditable.';

COMMIT;
