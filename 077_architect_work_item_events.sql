-- ============================================================================
-- 077_architect_work_item_events.sql
-- ----------------------------------------------------------------------------
-- FASE 5-hardening — dedicated event log for OpenClaude runs
--
-- evidence_records is the canonical compliance log (immutable, audited),
-- but it's heavyweight for the high-frequency operational telemetry the
-- live execution timeline needs (one row per gRPC event). This table is
-- purpose-built for that:
--
--   - 30-day retention (cleaned up by expiration worker)
--   - Per-work-item monotonic event_seq for stable ordering
--   - Indexed by (work_item_id, event_seq) for cheap timeline reads
--   - RLS-isolated like every other org-scoped table
--
-- Event types: RUN_STARTED, TEXT_CHUNK, TOOL_START, TOOL_RESULT,
--              ACTION_REQUIRED, ACTION_RESPONSE, RUN_COMPLETED,
--              RUN_FAILED, RUN_CANCELLED
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS architect_work_item_events (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    work_item_id UUID NOT NULL REFERENCES architect_work_items(id) ON DELETE CASCADE,
    event_type   VARCHAR(50) NOT NULL,
    event_seq    INTEGER NOT NULL DEFAULT 0,
    tool_name    VARCHAR(255),
    prompt_id    VARCHAR(255),
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wi_events_work_item
    ON architect_work_item_events (work_item_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_wi_events_created
    ON architect_work_item_events (created_at);
CREATE INDEX IF NOT EXISTS idx_wi_events_org_type
    ON architect_work_item_events (org_id, event_type, created_at DESC);

ALTER TABLE architect_work_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE architect_work_item_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_isolation_wi_events ON architect_work_item_events;
CREATE POLICY org_isolation_wi_events ON architect_work_item_events
    FOR ALL TO govai_app
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON architect_work_item_events TO govai_app;

COMMIT;
