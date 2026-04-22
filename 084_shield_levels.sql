-- Migration: 084_shield_levels.sql
-- FASE 13.5a — Three-tier governance model
-- ---------------------------------------------------------------------------
-- Adds shield_level to organizations and assistants, controlling how strictly
-- GovAI intervenes in execution flow.
--
-- Level 1 (Fluxo Livre, default):     DLP + audit + cost caps only.
--                                      Runtimes (Claude Code, OpenClaude) run
--                                      natively — no GovAI-side HITL on tool use.
-- Level 2 (Conformidade):              Level 1 + segregation of duties on
--                                      formal actions (policy publish, risk
--                                      assessment, security exceptions).
-- Level 3 (Blindagem Máxima):          Level 2 + tool-use classification and
--                                      HITL on destructive tools. This is
--                                      the behaviour shipped before 13.5a.
--
-- Default = 1 so greenfield deploys start with runtime-native execution.
-- Customers pursuing SOC 2 Type II should flip to 2 or 3 via the UI; the
-- switch records an immutable evidence record with the acknowledged
-- notice template hash.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── organizations ──────────────────────────────────────────────────────────
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS shield_level SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'organizations_shield_level_check'
    ) THEN
        ALTER TABLE organizations
            ADD CONSTRAINT organizations_shield_level_check
            CHECK (shield_level BETWEEN 1 AND 3);
    END IF;
END $$;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS shield_level_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS shield_level_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ── assistants ──────────────────────────────────────────────────────────────
-- NULL = inherit org; non-null must be ≥ org.shield_level (trigger below).
ALTER TABLE assistants
    ADD COLUMN IF NOT EXISTS shield_level SMALLINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'assistants_shield_level_check'
    ) THEN
        ALTER TABLE assistants
            ADD CONSTRAINT assistants_shield_level_check
            CHECK (shield_level IS NULL OR shield_level BETWEEN 1 AND 3);
    END IF;
END $$;

-- ── Trigger: override only upward ───────────────────────────────────────────
-- Forbids an assistant running at a LOWER shield_level than its org. Makes
-- the invariant "effective level = max(assistant, org)" a DB-level fact
-- rather than a service-side convention.
CREATE OR REPLACE FUNCTION enforce_assistant_shield_level_gte_org()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_org_level SMALLINT;
BEGIN
    IF NEW.shield_level IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT shield_level INTO v_org_level
    FROM organizations WHERE id = NEW.org_id;
    IF v_org_level IS NULL THEN
        RETURN NEW; -- org not found; let FK handle it
    END IF;
    IF NEW.shield_level < v_org_level THEN
        RAISE EXCEPTION
            'assistant.shield_level (%) cannot be lower than organization.shield_level (%)',
            NEW.shield_level, v_org_level;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_assistant_shield_level ON assistants;
CREATE TRIGGER trg_enforce_assistant_shield_level
    BEFORE INSERT OR UPDATE OF shield_level, org_id ON assistants
    FOR EACH ROW EXECUTE FUNCTION enforce_assistant_shield_level_gte_org();

-- ── evidence_category: add 'shield_level_change' ────────────────────────────
-- ALTER TYPE ADD VALUE needs to be outside a DO block when run with
-- exceptions; we guard with a pg_enum lookup (same pattern as migrations
-- 081 and 082).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'evidence_category'
          AND e.enumlabel = 'shield_level_change'
    ) THEN
        ALTER TYPE evidence_category ADD VALUE 'shield_level_change';
    END IF;
END $$;

-- ── Ensure demo org is at level 1 explicitly ────────────────────────────────
-- The DEFAULT picks up new rows, but a pre-existing seed row inserted before
-- the column existed will get a NULL when the column is added (if the
-- ALTER runs against a legacy DB without the default propagating).
-- IS NOT DISTINCT FROM is a no-op on already-at-1 rows.
UPDATE organizations
    SET shield_level = 1
    WHERE id = '00000000-0000-0000-0000-000000000001'
      AND shield_level IS NULL;

COMMIT;
