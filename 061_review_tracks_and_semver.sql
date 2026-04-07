-- Migration: 061_review_tracks_and_semver.sql
-- Objetivo: Multi-track review system + semantic versioning on assistant_versions

BEGIN;

-- ═══════════════════════════════════════════════
-- PART A: Multi-Track Review System
-- ═══════════════════════════════════════════════

-- Track definitions per organization
CREATE TABLE IF NOT EXISTS review_tracks (
    id          uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name        varchar(100) NOT NULL,
    slug        varchar(50)  NOT NULL,
    description text,
    is_required boolean DEFAULT true,
    sla_hours   integer DEFAULT 72,
    sort_order  integer DEFAULT 0,
    created_at  timestamptz DEFAULT now(),
    UNIQUE(org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_review_tracks_org
    ON review_tracks(org_id, sort_order);

-- Per-assistant, per-version review decisions
CREATE TABLE IF NOT EXISTS review_decisions (
    id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    assistant_id   uuid NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    version_id     uuid REFERENCES assistant_versions(id) ON DELETE SET NULL,
    track_id       uuid NOT NULL REFERENCES review_tracks(id) ON DELETE CASCADE,
    reviewer_id    uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewer_email varchar(255),
    decision       varchar(20) NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending', 'approved', 'rejected', 'escalated')),
    notes          text,
    decided_at     timestamptz,
    escalated_at   timestamptz,
    created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_decisions_assistant
    ON review_decisions(assistant_id, track_id);
CREATE INDEX IF NOT EXISTS idx_review_decisions_pending
    ON review_decisions(decision) WHERE decision = 'pending';
CREATE INDEX IF NOT EXISTS idx_review_decisions_org
    ON review_decisions(org_id, decision);

-- RLS
ALTER TABLE review_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_tracks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_tracks_isolation ON review_tracks;
CREATE POLICY review_tracks_isolation ON review_tracks
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_decisions_isolation ON review_decisions;
CREATE POLICY review_decisions_isolation ON review_decisions
    FOR ALL TO govai_app
    USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
    WITH CHECK (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON review_tracks   TO govai_app;
GRANT SELECT, INSERT, UPDATE ON review_decisions TO govai_app;

-- ═══════════════════════════════════════════════
-- PART B: Semantic Versioning
-- ═══════════════════════════════════════════════

ALTER TABLE assistant_versions
    ADD COLUMN IF NOT EXISTS version_major integer DEFAULT 1,
    ADD COLUMN IF NOT EXISTS version_minor integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS version_patch integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS change_type   varchar(10) DEFAULT 'patch'
        CHECK (change_type IN ('major', 'minor', 'patch')),
    ADD COLUMN IF NOT EXISTS changelog text;

-- Backfill existing versions with 1.0.0
UPDATE assistant_versions
    SET version_major = 1, version_minor = 0, version_patch = 0
    WHERE version_major IS NULL OR version_major = 0;

-- ═══════════════════════════════════════════════
-- PART C: Immutability trigger for review_decisions
-- ═══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION prevent_review_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.decision IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Review decisions are immutable once finalized.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_review_decision ON review_decisions;
CREATE TRIGGER trg_immutable_review_decision
    BEFORE UPDATE ON review_decisions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_review_decision_mutation();

COMMIT;
