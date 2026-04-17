-- Migration: 083_locale_preference.sql
-- FASE 13.3 — per-organization locale preference for backend-originated
-- communications (emails, Slack/Teams notifications, SIEM event labels,
-- PDF reports). The UI locale is picked per-user via cookie; this
-- column answers "what language should the platform use when it
-- initiates a message to this org?"
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'pt-BR';

-- Idempotent CHECK constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'organizations_locale_check'
    ) THEN
        ALTER TABLE organizations
            ADD CONSTRAINT organizations_locale_check
            CHECK (locale IN ('pt-BR', 'en'));
    END IF;
END $$;

COMMIT;
