-- ============================================================================
-- 080_notification_channels_siem.sql
-- ----------------------------------------------------------------------------
-- FASE 12 — SIEM streaming
--
-- Extends notification_channels.provider CHECK constraint to accept
-- two new values:
--   - siem_webhook: JSON payload over HTTPS (Elastic, Datadog, generic SIEM)
--   - siem_cef:     CEF v0 over HTTPS (Splunk, Sentinel, QRadar)
--
-- The webhook_url, auth_header, and events array already live in the
-- existing `config` JSONB column — no new columns needed.
-- ============================================================================

BEGIN;

ALTER TABLE notification_channels
    DROP CONSTRAINT IF EXISTS notification_channels_provider_check;

ALTER TABLE notification_channels
    ADD CONSTRAINT notification_channels_provider_check
    CHECK (provider IN ('slack', 'teams', 'email', 'siem_webhook', 'siem_cef'));

CREATE INDEX IF NOT EXISTS idx_notification_channels_org_siem
    ON notification_channels(org_id, provider)
    WHERE provider IN ('siem_webhook', 'siem_cef') AND is_active = true;

COMMIT;
