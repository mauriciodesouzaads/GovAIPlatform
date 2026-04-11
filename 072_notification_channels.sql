-- ============================================================================
-- Migration 072 — Notification Channels (Slack / Teams / Email)
-- Per-org configurable channels that map event types to webhook URLs.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notification_channels (
    id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- Human-readable name
    name        VARCHAR(255) NOT NULL,

    -- Provider: 'slack' | 'teams' | 'email'
    provider    VARCHAR(20)  NOT NULL CHECK (provider IN ('slack', 'teams', 'email')),

    -- Provider-specific config (JSONB):
    --   Slack/Teams: { "webhook_url": "https://..." }
    --   Email:       { "recipients": ["a@b.com"], "smtp_from": "govai@org.com" }
    config      JSONB        NOT NULL DEFAULT '{}',

    -- Events that trigger a notification on this channel.
    -- Values: policy.violation | execution.error | exception.expiring |
    --         exception.created | assistant.published | review.completed |
    --         alert.high_latency | alert.high_violation | alert.high_cost |
    --         dlp.block | risk.assessment_completed
    events      TEXT[]       NOT NULL DEFAULT '{}',

    is_active   BOOLEAN      NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (org_id, name)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS notification_channels_org_active_idx
    ON notification_channels (org_id, is_active)
    WHERE is_active = true;

-- ── RLS ───────────────────────────────────────────────────────────────────────

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation_notification_channels ON notification_channels
    USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ── Grants ────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_channels TO govai_app;

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_notification_channels_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS notification_channels_updated_at ON notification_channels;
CREATE TRIGGER notification_channels_updated_at
    BEFORE UPDATE ON notification_channels
    FOR EACH ROW EXECUTE FUNCTION set_notification_channels_updated_at();

COMMIT;
