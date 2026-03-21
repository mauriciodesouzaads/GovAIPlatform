-- Migration 038: Fix version publish flow (GA-009)
--
-- Adopts Model A (real immutability):
--   • assistant_versions NEVER receives UPDATE (trigger already enforces this)
--   • status is set once at INSERT time
--   • Publication is recorded in assistant_publication_events (immutable audit trail)
--   • The /approve route is deprecated for status mutation

-- Ensure new versions default to 'draft'
ALTER TABLE assistant_versions
    ALTER COLUMN status SET DEFAULT 'draft';

-- Immutable audit trail for publication events
CREATE TABLE IF NOT EXISTS assistant_publication_events (
    id           uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    assistant_id uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    version_id   uuid NOT NULL REFERENCES assistant_versions(id),
    published_by uuid REFERENCES users(id),
    published_at timestamptz DEFAULT now(),
    org_id       uuid NOT NULL REFERENCES organizations(id),
    notes        text
);

CREATE INDEX IF NOT EXISTS idx_pub_events_assistant
    ON assistant_publication_events(assistant_id);

-- RLS: each org sees only its own publication events
ALTER TABLE assistant_publication_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_publication_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pub_events_isolation ON assistant_publication_events;
CREATE POLICY pub_events_isolation ON assistant_publication_events
    FOR ALL TO govai_app
    USING (org_id = current_setting('app.current_org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

-- Grant table access to app role
GRANT SELECT, INSERT ON assistant_publication_events TO govai_app;
